#!/usr/bin/env python3
"""JOYA Library service: view counts, the studio (sign-in, uploads, encoding jobs, editing).

  python3 library/server.py            (systemd unit joya-library, 127.0.0.1:8795 behind nginx)

Public, no login:
  GET  /api/stats?ids=a,b,u:<token>   views and unique viewers (public videos, or unlisted by token)
  POST /api/beat                      playback report from count.js (see count.js for the rules)
  GET  /api/health
Studio (signed in; every write also needs a same-origin request):
  GET  /studio/  /studio/login  /studio/v/<slug>         pages
  GET  /studio/media/<slug>/<file>                         a video's files, any visibility (nginx serves them)
  /api/studio/...                                          see the routes table at the bottom

Standard library only. State: SQLite at JOYA_LIBRARY_DB, the HMAC secret at JOYA_LIBRARY_SECRET.
No raw IP address is ever stored: only keyed hashes, and those of IPs only in memory.
"""
import base64
import datetime
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joyalib as L  # noqa: E402
import build  # noqa: E402
import ops  # noqa: E402
import pipeline as P  # noqa: E402

PORT = int(os.environ.get('JOYA_LIBRARY_PORT', '8795'))
BIND = os.environ.get('JOYA_LIBRARY_BIND', '127.0.0.1')
ORIGIN = '{0.scheme}://{0.netloc}'.format(urlsplit(L.BASE_URL))
COOKIE_SECURE = os.environ.get('JOYA_LIBRARY_COOKIE_SECURE', '1') != '0'
SESSION_DAYS = 14
CHUNK = 8 * 1024 * 1024           # upload chunk size the studio uses (nginx allows 16 MB on /api/)
MAX_CHUNK = 16 * 1024 * 1024
MAX_UPLOAD = 50 * 1024 ** 3       # 50 GB per file
VIEW_MIN_S = 30.0                  # a view: 30 s of real playback, or half of a shorter video
DEDUP_S = 30 * 60                  # one view per device per video in 30 minutes
SESSION_COOKIE = 'mlsess'
BOT_RE = re.compile(r'bot|crawl|spider|slurp|headless|phantom|lighthouse|curl|wget|python|httpclient|okhttp|'
                    r'go-http|java/|scrapy|facebookexternalhit|embedly|preview|monitor|uptime', re.I)
HEX32 = re.compile(r'^[0-9a-f]{32}$')
HEX16 = re.compile(r'^[0-9a-f]{16}$')
FILE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$')

_tls = threading.local()


# ---------------------------------------------------------------- secret, db
def secret():
    if not hasattr(secret, 'v'):
        if not os.path.exists(L.SECRET_PATH):
            os.makedirs(os.path.dirname(L.SECRET_PATH), exist_ok=True)
            fd = os.open(L.SECRET_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(secrets.token_bytes(32))
        with open(L.SECRET_PATH, 'rb') as f:
            secret.v = f.read()
        if len(secret.v) < 32:
            raise SystemExit('the secret file is too short')
    return secret.v


def keyed(text):
    return hmac.new(secret(), text.encode('utf-8', 'replace'), hashlib.sha256).hexdigest()[:32]


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
  created INTEGER NOT NULL, last_login INTEGER, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plays (pid TEXT NOT NULL, video TEXT NOT NULL, device TEXT NOT NULL, src TEXT NOT NULL,
  ref TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, watched REAL NOT NULL DEFAULT 0,
  maxpos REAL NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 0, counted_at INTEGER,
  PRIMARY KEY (video, pid));
CREATE INDEX IF NOT EXISTS plays_counted ON plays (video, counted, counted_at);
CREATE INDEX IF NOT EXISTS plays_device ON plays (video, device, counted_at);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
  size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, fingerprint TEXT, meta TEXT,
  status TEXT NOT NULL DEFAULT 'uploading', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, upload_id TEXT NOT NULL, status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
  slug TEXT, title TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, slug TEXT,
  detail TEXT NOT NULL DEFAULT '');
"""


def db():
    c = getattr(_tls, 'db', None)
    if c is None:
        c = sqlite3.connect(L.DB_PATH, timeout=15, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA synchronous=NORMAL')
        c.execute('PRAGMA busy_timeout=15000')
        _tls.db = c
    return c


def init_db():
    os.makedirs(os.path.dirname(L.DB_PATH), exist_ok=True)
    # Created 0600 before SQLite opens it: its -wal and -shm files take the same mode.
    if not os.path.exists(L.DB_PATH):
        os.close(os.open(L.DB_PATH, os.O_WRONLY | os.O_CREAT, 0o600))
    for suffix in ('', '-wal', '-shm'):
        if os.path.exists(L.DB_PATH + suffix):
            os.chmod(L.DB_PATH + suffix, 0o600)
    db().executescript(SCHEMA)


def audit(user_id, action, slug=None, detail=''):
    db().execute('INSERT INTO audit (at, user_id, action, slug, detail) VALUES (?,?,?,?,?)',
                 (int(time.time()), user_id, action, slug, detail[:500]))


# ---------------------------------------------------------------- passwords
def hash_password(pw):
    salt = secrets.token_bytes(16)
    n, r, p = 2 ** 15, 8, 1
    dk = hashlib.scrypt(pw.encode('utf-8'), salt=salt, n=n, r=r, p=p, maxmem=64 * 1024 * 1024, dklen=32)
    return 'scrypt$%d$%d$%d$%s$%s' % (n, r, p, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def check_password(pw, stored):
    try:
        kind, n, r, p, salt, dk = stored.split('$')
        assert kind == 'scrypt'
        got = hashlib.scrypt(pw.encode('utf-8'), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=64 * 1024 * 1024, dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except Exception:
        return False


DUMMY_HASH = None


# ---------------------------------------------------------------- rate limits (memory only)
class Limiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.hits = {}

    def hit(self, key, limit, window, count=True):
        """True when `key` is still under `limit` events in `window` seconds (and records one)."""
        now = time.time()
        with self.lock:
            q = [t for t in self.hits.get(key, []) if now - t < window]
            ok = len(q) < limit
            if ok and count:
                q.append(now)
            self.hits[key] = q
            if len(self.hits) > 50000:
                for k in list(self.hits)[:10000]:
                    if not self.hits[k] or now - self.hits[k][-1] > 3600:
                        del self.hits[k]
            return ok

    def peek(self, key, limit, window):
        return self.hit(key, limit, window, count=False)

    def add(self, key):
        with self.lock:
            self.hits.setdefault(key, []).append(time.time())

    def clear(self, key):
        with self.lock:
            self.hits.pop(key, None)


LIMIT = Limiter()


# ---------------------------------------------------------------- manifest cache
class Manifest:
    def __init__(self):
        self.lock = threading.Lock()
        self.mtime = None
        self.data = None

    def get(self):
        try:
            m = os.stat(L.MANIFEST).st_mtime_ns
        except FileNotFoundError:
            m = 0
        with self.lock:
            if self.data is None or m != self.mtime:
                self.data = L.load() if m else {'folders': [], 'videos': [], 'moved': []}
                self.mtime = m
            return self.data


MAN = Manifest()


def resolve_key(k):
    """Stats key -> video entry (public by slug, unlisted by u:<token>); None otherwise."""
    data = MAN.get()
    if not isinstance(k, str) or len(k) > 120:
        return None
    if k.startswith('u:'):
        tok = k[2:]
        if not L.TOKEN_RE.match(tok):
            return None
        v = next((v for v in data['videos'] if v.get('token') == tok), None)
        return v if v and L.is_unlisted(v) and not v.get('processing') else None
    v = L.find(data, k)
    return v if v and L.is_public(v) and not v.get('processing') else None


# ---------------------------------------------------------------- counts
_count_cache = {}
_count_lock = threading.Lock()


def counts_for(slugs, fresh=False):
    out = {}
    need = []
    now = time.time()
    with _count_lock:
        for s in slugs:
            c = _count_cache.get(s)
            if c and not fresh and now - c[0] < 10:
                out[s] = c[1]
            else:
                need.append(s)
    if need:
        q = ','.join('?' * len(need))
        rows = db().execute('SELECT video, COUNT(*) AS v, COUNT(DISTINCT device) AS u FROM plays '
                            'WHERE counted = 1 AND video IN (%s) GROUP BY video' % q, need).fetchall()
        got = {r['video']: {'v': r['v'], 'u': r['u']} for r in rows}
        with _count_lock:
            for s in need:
                val = got.get(s, {'v': 0, 'u': 0})
                _count_cache[s] = (now, val)
                out[s] = val
    return out


def forget_count(slug):
    with _count_lock:
        _count_cache.pop(slug, None)


# ---------------------------------------------------------------- jobs (encoding in the background)
_job_wake = threading.Event()


def job_worker():
    while True:
        try:
            row = db().execute("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").fetchone()
            if not row:
                _job_wake.wait(5)
                _job_wake.clear()
                continue
            run_job(row)
        except Exception:
            traceback.print_exc()
            time.sleep(2)


def run_job(job):
    c = db()
    up = c.execute('SELECT * FROM uploads WHERE id = ?', (job['upload_id'],)).fetchone()
    c.execute("UPDATE jobs SET status='running', stage='Starting', progress=0, message='', updated=? WHERE id=?",
              (int(time.time()), job['id']))
    meta = json.loads(up['meta'] or '{}')
    path = upload_path(up['id'])
    last = [0.0]

    def progress(text, frac):
        now = time.time()
        if now - last[0] < 0.8 and frac < 1:
            return
        last[0] = now
        c.execute('UPDATE jobs SET stage=?, progress=?, updated=? WHERE id=?',
                  (text, round(max(0.0, min(1.0, frac)), 4), int(now), job['id']))
    try:
        meta['source_name'] = up['name']
        entry = P.ingest(path, meta, progress, new_only=True)
        keep_source(path, entry['slug'], up['name'])
        c.execute("UPDATE jobs SET status='done', stage='Done', progress=1, slug=?, updated=? WHERE id=?",
                  (entry['slug'], int(time.time()), job['id']))
        c.execute("UPDATE uploads SET status='done', updated=? WHERE id=?", (int(time.time()), up['id']))
        audit(up['user_id'], 'publish', entry['slug'], '%s, %s' % (entry['visibility'], up['name']))
    except Exception as e:
        msg = str(e) if isinstance(e, (P.PipelineError, ops.OpError)) else 'Processing failed (%s).' % type(e).__name__
        traceback.print_exc()
        c.execute("UPDATE jobs SET status='failed', message=?, updated=? WHERE id=?",
                  (msg[:600], int(time.time()), job['id']))


def keep_source(path, slug, name):
    """The uploaded original is kept (outside the web root) so a video can be re-encoded later."""
    d = os.path.join(L.SOURCE_ROOT, slug)
    os.makedirs(d, mode=0o700, exist_ok=True)
    safe = re.sub(r'[^A-Za-z0-9._-]+', '_', name)[:120] or 'source'
    dst = os.path.join(d, safe)
    if os.path.exists(dst):
        dst = os.path.join(d, '%d-%s' % (int(time.time()), safe))
    shutil.move(path, dst)
    os.chmod(dst, 0o600)


def upload_path(uid):
    return os.path.join(L.UPLOAD_ROOT, uid + '.bin')


def recover_jobs():
    c = db()
    c.execute("UPDATE jobs SET status='failed', message='The service restarted while this was processing. Retry it.' "
              "WHERE status = 'running'")


def maybe_queue(up_id):
    c = db()
    up = c.execute('SELECT * FROM uploads WHERE id=?', (up_id,)).fetchone()
    if not up or up['received'] < up['size'] or not up['meta'] or up['status'] != 'uploading':
        return None
    meta = json.loads(up['meta'])
    now = int(time.time())
    c.execute("UPDATE uploads SET status='queued', updated=? WHERE id=?", (now, up_id))
    cur = c.execute("INSERT INTO jobs (upload_id, status, title, created, updated) VALUES (?, 'queued', ?, ?, ?)",
                    (up_id, meta.get('title', ''), now, now))
    _job_wake.set()
    return cur.lastrowid


# ---------------------------------------------------------------- studio data
def video_summary(v, counts):
    c = counts.get(v['slug'], {'v': 0, 'u': 0})
    vis = 'trash' if v.get('trashed') else v.get('visibility', 'public')
    base = '/studio/media/%s/' % v['slug']
    return {
        'slug': v['slug'], 'title': v['title'], 'desc': v.get('desc', ''), 'folder': v['folder'],
        'date': v.get('date'), 'duration': v.get('duration'), 'visibility': vis,
        'trashed_at': (v.get('trashed') or {}).get('at'), 'processing': bool(v.get('processing')),
        'poster': (base + v['poster']['small'] + '?v=' + build.stamp(v)) if v.get('poster') else None,
        'url': (L.BASE_URL + L.page_path(v)) if L.page_path(v) else None,
        'views': c['v'], 'uniques': c['u'], 'updated': v.get('updated'),
    }


def analytics(v):
    c = db()
    slug = v['slug']
    dur = float(v.get('duration') or 1)
    tot = counts_for([slug], fresh=True)[slug]
    w = c.execute('SELECT COALESCE(SUM(MIN(watched, ?)), 0) AS ws, COUNT(*) AS plays FROM plays '
                  'WHERE video = ? AND watched > 0', (dur * 3, slug)).fetchone()
    watch_s = float(w['ws'])
    days = []
    today = datetime.datetime.now(datetime.timezone.utc).date()
    start = today - datetime.timedelta(days=27)
    t0 = int(datetime.datetime.combine(start, datetime.time(), datetime.timezone.utc).timestamp())
    rows = c.execute("SELECT strftime('%Y-%m-%d', counted_at, 'unixepoch') AS d, COUNT(*) AS n, "
                     "COUNT(DISTINCT device) AS u FROM plays WHERE video = ? AND counted = 1 AND counted_at >= ? "
                     "GROUP BY d", (slug, t0)).fetchall()
    by = {r['d']: (r['n'], r['u']) for r in rows}
    for i in range(28):
        d = (start + datetime.timedelta(days=i)).isoformat()
        n, u = by.get(d, (0, 0))
        days.append({'date': d, 'views': n, 'uniques': u})
    src = c.execute('SELECT src, ref, COUNT(*) AS n FROM plays WHERE video = ? AND counted = 1 GROUP BY src, ref '
                    'ORDER BY n DESC', (slug,)).fetchall()
    sources = {}
    for r in src:
        if r['src'] == 'embed':
            label = 'Embedded on %s' % r['ref'] if r['ref'] and r['ref'] != 'self' else 'Embedded (site unknown)'
        elif r['ref'] == 'self':
            label = 'JOYA Library pages'
        elif r['ref']:
            label = 'Links from %s' % r['ref']
        else:
            label = 'Direct or unknown'
        sources[label] = sources.get(label, 0) + r['n']
    avg_view = watch_s / tot['v'] if tot['v'] else 0
    return {
        'views': tot['v'], 'uniques': tot['u'], 'plays': w['plays'], 'watch_seconds': round(watch_s, 1),
        'avg_view_seconds': round(avg_view, 1), 'avg_percent': round(min(1.0, avg_view / dur) * 100, 1) if tot['v'] else 0,
        'days': days, 'sources': sorted(({'label': k, 'views': n} for k, n in sources.items()), key=lambda x: -x['views']),
        'tz': 'UTC',
    }


def links_for(v):
    out = {'page': None, 'embed': None}
    if L.page_path(v):
        out['page'] = L.BASE_URL + L.page_path(v)
        out['embed'] = L.BASE_URL + L.embed_path(v)
        out['embed_code'] = build.embed_code(v)
    return out


def job_rows():
    c = db()
    rows = c.execute("SELECT j.*, u.name AS file, u.size AS size FROM jobs j JOIN uploads u ON u.id = j.upload_id "
                     "WHERE j.status IN ('queued','running','failed') OR j.updated > ? ORDER BY j.id DESC LIMIT 30",
                     (int(time.time()) - 600,)).fetchall()
    return [{'id': r['id'], 'status': r['status'], 'stage': r['stage'], 'progress': r['progress'],
             'message': r['message'], 'slug': r['slug'], 'title': r['title'], 'file': r['file'], 'size': r['size'],
             'updated': r['updated']} for r in rows]


# ---------------------------------------------------------------- HTML for studio pages
def studio_page(title, page, user=None, attrs='', main=''):
    build.VER.clear()
    build.ensure_versions()
    a = build.asset
    who = ''
    if user:
        who = ('<div class="topbar-end"><a class="toplink-quiet" href="/" target="_blank" rel="noopener">View library'
               '</a><span class="who" title="Signed in">%s</span>'
               '<button type="button" class="btn btn-small" id="signout">Sign out</button></div>') % html.escape(user['name'])
    return '\n'.join([
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<title>%s · JOYA Studio</title>' % html.escape(title),
        '<meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark">',
        '<link rel="icon" href="%s" type="image/svg+xml">' % a('favicon.svg'),
        '<link rel="stylesheet" href="%s"><link rel="stylesheet" href="%s"><link rel="stylesheet" href="%s">' % (
            a('site.css'), a('player.css'), a('studio.css')),
        '</head>',
        '<body class="studio" data-page="%s"%s>' % (page, attrs),
        '<a class="skip-link" href="#main">Skip to the content</a>',
        '<header class="topbar"><div class="topbar-in"><a class="brand" href="/studio/" aria-label="JOYA Studio, your videos">'
        '<span class="wordmark"><span class="wm-joya">JOYA</span><span class="wm-sub">Studio</span></span></a>%s</div></header>' % who,
        '<main id="main" tabindex="-1">%s</main>' % main,
        '<script src="%s" defer></script>' % a('player.js'),
        '<script src="%s" defer></script>' % a('studio.js'),
        '</body></html>', ''])


def login_page(error='', name='', nxt='/studio/'):
    err = ('<p class="form-error" role="alert"><span aria-hidden="true">▲ </span>%s</p>' % html.escape(error)) if error else ''
    return studio_page('Sign in', 'login', main=(
        '<div class="login"><h1>Sign in to the studio</h1>'
        '<p class="lead">The studio is where videos are uploaded and managed. Watching needs no account.</p>%s'
        '<form class="login-form" id="login-form" method="post" action="/api/studio/login">'
        '<input type="hidden" name="next" value="%s">'
        '<div class="field"><label for="name">User name</label>'
        '<input id="name" name="name" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" '
        'required value="%s"></div>'
        '<div class="field"><label for="password">Password</label>'
        '<input id="password" name="password" type="password" autocomplete="current-password" required></div>'
        '<button class="btn btn-primary btn-wide" type="submit">Sign in</button></form>'
        '<p class="login-foot"><a href="/">Back to the library</a></p></div>') % (
        err, html.escape(nxt), html.escape(name)))


# ---------------------------------------------------------------- HTTP
class ApiError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


ROUTES = []


def route(method, pattern, auth=False):
    rx = re.compile('^' + pattern + '$')

    def deco(fn):
        ROUTES.append((method, rx, auth, fn))
        return fn
    return deco


class Handler(BaseHTTPRequestHandler):
    server_version = 'joya-library'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 120

    def log_message(self, fmt, *args):  # no client IPs in the journal; nginx has the access log
        pass

    # -- helpers
    def client_ip(self):
        ip = self.client_address[0]
        if ip in ('127.0.0.1', '::1'):
            ip = self.headers.get('X-Real-IP') or ip
        return ip

    def ip_key(self):
        return keyed('i:' + self.client_ip())

    def ua(self):
        return (self.headers.get('User-Agent') or '')[:400]

    def cookies(self):
        out = {}
        for part in (self.headers.get('Cookie') or '').split(';'):
            if '=' in part:
                k, v = part.strip().split('=', 1)
                out[k] = v
        return out

    def read_body(self, limit):
        self._body_read = True
        n = int(self.headers.get('Content-Length') or 0)
        if n < 0 or n > limit:
            raise ApiError(413, 'That request is too large.')
        data = b''
        while len(data) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(data)))
            if not chunk:
                raise ApiError(400, 'The upload stopped part way.')
            data += chunk
        return data

    def json_body(self, limit=1 << 20):
        raw = self.read_body(limit)
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip()
        if ctype == 'application/x-www-form-urlencoded':
            return {k: v[0] for k, v in parse_qs(raw.decode('utf-8', 'replace')).items()}
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except ValueError:
            raise ApiError(400, 'The request could not be read.')

    def send(self, status, body=b'', ctype='application/json; charset=utf-8', headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        elif isinstance(body, str):
            body = body.encode('utf-8')
        # A body the handler did not read must not stay on a kept-alive connection (nginx reuses it):
        # read and drop a small one, else close the connection after this response.
        close = False
        if not getattr(self, '_body_read', True):
            self._body_read = True
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = -1
            if 0 < n <= (1 << 20):
                try:
                    self.rfile.read(n)
                except OSError:
                    close = True
            elif n != 0 or self.headers.get('Transfer-Encoding'):
                close = True
        self.send_response(status)
        if close:
            self.close_connection = True
            self.send_header('Connection', 'close')
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        hdrs = {'Cache-Control': 'no-store'}
        hdrs.update(headers or {})
        for k, v in hdrs.items():
            if isinstance(v, list):
                for x in v:
                    self.send_header(k, x)
            else:
                self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def redirect(self, to, headers=None):
        h = {'Location': to}
        h.update(headers or {})
        self.send(303, b'', 'text/plain', h)

    def same_origin(self):
        """CSRF: a write must come from a page of this site (Origin, else Sec-Fetch-Site / Referer)."""
        origin = self.headers.get('Origin')
        if origin:
            return origin == ORIGIN
        site = self.headers.get('Sec-Fetch-Site')
        if site:
            return site == 'same-origin'
        ref = self.headers.get('Referer') or ''
        return ref.startswith(ORIGIN + '/')

    def session(self):
        tok = self.cookies().get(SESSION_COOKIE)
        if not tok or len(tok) > 100:
            return None
        h = hashlib.sha256(tok.encode()).hexdigest()
        now = int(time.time())
        row = db().execute('SELECT s.*, u.name, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id '
                           'WHERE s.hash = ?', (h,)).fetchone()
        if not row or row['expires'] < now or row['disabled']:
            return None
        if now - row['last_seen'] > 300:
            db().execute('UPDATE sessions SET last_seen=?, expires=? WHERE hash=?',
                         (now, now + SESSION_DAYS * 86400, h))
            self._refresh_cookie = tok
        return {'id': row['user_id'], 'name': row['name'], 'hash': h}

    def cookie_header(self, tok, max_age):
        return '%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Strict%s' % (
            SESSION_COOKIE, tok, max_age, '; Secure' if COOKIE_SECURE else '')

    # -- dispatch
    def handle_any(self):
        self._refresh_cookie = None
        self._body_read = False
        parts = urlsplit(self.path)
        path = parts.path
        self.query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        try:
            for method, rx, auth, fn in ROUTES:
                m = rx.match(path)
                if not m or (method != self.command and not (method == 'GET' and self.command == 'HEAD')):
                    continue
                user = None
                if auth:
                    user = self.session()
                    if not user:
                        if path.startswith('/api/'):
                            raise ApiError(401, 'Sign in to the studio first.')
                        return self.redirect('/studio/login?next=' + path)
                    if self.command not in ('GET', 'HEAD') and not self.same_origin():
                        raise ApiError(403, 'This request did not come from the studio page.')
                return fn(self, user, *m.groups())
            if any(rx.match(path) for _, rx, _, _ in ROUTES):
                raise ApiError(405, 'That method is not allowed here.')
            raise ApiError(404, 'Not found.')
        except ApiError as e:
            body = {'error': e.message}
            body.update(e.extra)
            self.send(e.status, body)
        except (ops.OpError, P.PipelineError) as e:
            self.send(400, {'error': str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send(500, {'error': 'Something went wrong on the server.'})
            except Exception:
                pass

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any

    def ok(self, body, headers=None):
        h = dict(headers or {})
        if self._refresh_cookie:
            h['Set-Cookie'] = self.cookie_header(self._refresh_cookie, SESSION_DAYS * 86400)
        self.send(200, body, headers=h)


# ---------------------------------------------------------------- public API
@route('GET', r'/api/health')
def api_health(h, user):
    h.send(200, {'ok': True})


@route('GET', r'/api/stats')
def api_stats(h, user):
    if not LIMIT.hit('s:' + h.ip_key(), 240, 60):
        raise ApiError(429, 'Too many requests. Try again in a minute.')
    ids = [x for x in (h.query.get('ids') or '').split(',') if x][:200]
    data = MAN.get()
    if not ids:
        ids = [v['slug'] for v in data['videos'] if L.is_public(v) and not v.get('processing')]
    want = {}
    for k in ids:
        v = resolve_key(k)
        if v:
            want[k] = v['slug']
    got = counts_for(sorted(set(want.values())))
    h.send(200, {'counts': {k: got[s] for k, s in want.items()}}, headers={'Cache-Control': 'public, max-age=10'})


@route('POST', r'/api/beat')
def api_beat(h, user):
    ipk = h.ip_key()
    if BOT_RE.search(h.ua()) or not h.ua():
        return h.send(204)
    if not LIMIT.hit('b:' + ipk, 120, 60):
        raise ApiError(429, 'Too many reports.')
    try:
        b = json.loads(h.read_body(4096).decode('utf-8'))
        assert isinstance(b, dict)
    except Exception:
        raise ApiError(400, 'Bad report.')
    v = resolve_key(b.get('k'))
    pid = b.get('pid') or ''
    if not v or not HEX16.match(pid):
        return h.send(204)
    did = b.get('did') or h.cookies().get('mlid') or ''
    device = keyed('d:' + did) if HEX32.match(did) else keyed('f:' + h.client_ip() + '|' + h.ua())
    src = 'embed' if b.get('src') == 'embed' else 'page'
    ref = str(b.get('ref') or '')[:100].lower()
    if ref and ref != 'self' and not re.match(r'^[a-z0-9.-]+(:\d+)?$', ref):
        ref = ''
    try:
        w = max(0.0, float(b.get('w') or 0))
        p = max(0.0, float(b.get('p') or 0))
    except (TypeError, ValueError):
        w = p = 0.0
    dur = float(v.get('duration') or 1)
    slug = v['slug']
    now = int(time.time())
    c = db()
    c.execute('BEGIN IMMEDIATE')
    counted_now = False
    try:
        row = c.execute('SELECT * FROM plays WHERE video = ? AND pid = ?', (slug, pid)).fetchone()
        if row is None:
            if not LIMIT.hit('p:' + ipk, 60, 600):
                c.execute('ROLLBACK')
                raise ApiError(429, 'Too many plays from here. Try again later.')
            # The first report opens the play; playback has only just begun, so what it may claim is small.
            w = min(w, 5.0)
            c.execute('INSERT INTO plays (pid, video, device, src, ref, created, updated, watched, maxpos) '
                      'VALUES (?,?,?,?,?,?,?,?,?)', (pid, slug, device, src, ref, now, now, w, min(p, dur)))
            row = c.execute('SELECT * FROM plays WHERE video = ? AND pid = ?', (slug, pid)).fetchone()
        elif row['device'] != device:
            c.execute('ROLLBACK')
            return h.send(204)
        else:
            # Real time bounds what can have been watched (up to 2× speed, plus slack).
            cap = (now - row['created']) * 2.1 + 5
            w = max(row['watched'], min(w, cap, dur * 3))
            c.execute('UPDATE plays SET watched=?, maxpos=MAX(maxpos, ?), updated=? WHERE video=? AND pid=?',
                      (w, min(p, dur), now, slug, pid))
        if row['counted'] == 0 and w >= min(VIEW_MIN_S, dur / 2.0):
            dup = c.execute('SELECT 1 FROM plays WHERE video = ? AND device = ? AND counted = 1 AND counted_at > ? '
                            'LIMIT 1', (slug, device, now - DEDUP_S)).fetchone()
            if dup:
                state = 2   # same device, same video, within 30 minutes: not a new view
            elif not LIMIT.hit('v:' + ipk, 40, 3600):
                state = 3   # too many views from one address in an hour
            else:
                state = 1
                counted_now = True
            c.execute('UPDATE plays SET counted=?, counted_at=? WHERE video=? AND pid=?', (state, now, slug, pid))
        c.execute('COMMIT')
    except ApiError:
        raise
    except Exception:
        try:
            c.execute('ROLLBACK')
        except Exception:
            pass
        raise
    if counted_now:
        forget_count(slug)
    cnt = counts_for([slug])[slug]
    h.send(200, {'counted': counted_now, 'views': cnt['v'], 'uniques': cnt['u']})


# ---------------------------------------------------------------- sign in
@route('GET', r'/studio/login')
def page_login(h, user):
    if h.session():
        return h.redirect('/studio/')
    nxt = h.query.get('next') or '/studio/'
    if not nxt.startswith('/studio/'):
        nxt = '/studio/'
    h.send(200, login_page(nxt=nxt), 'text/html; charset=utf-8', headers=studio_headers())


def studio_headers():
    return {'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
                                       "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
                                       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store'}


@route('POST', r'/api/studio/login')
def api_login(h, user):
    form = (h.headers.get('Content-Type') or '').startswith('application/x-www-form-urlencoded')
    if not h.same_origin():
        raise ApiError(403, 'This request did not come from the sign-in page.')
    b = h.json_body(8192)
    name = str(b.get('name') or '').strip().lower()[:64]
    pw = str(b.get('password') or '')[:1024]
    nxt = str(b.get('next') or '/studio/')
    if not nxt.startswith('/studio/') or nxt.startswith('/studio/login'):
        nxt = '/studio/'
    ipk, uk = 'l:' + h.ip_key(), 'lu:' + keyed('u:' + name)
    if not LIMIT.peek(ipk, 10, 900) or not LIMIT.peek(uk, 10, 900):
        msg = 'Too many attempts. Wait 15 minutes and try again.'
        if form:
            return h.send(429, login_page(msg, name, nxt), 'text/html; charset=utf-8', headers=studio_headers())
        raise ApiError(429, msg)
    row = db().execute('SELECT * FROM users WHERE name = ? AND disabled = 0', (name,)).fetchone()
    good = check_password(pw, row['pw'] if row else DUMMY_HASH)
    if not row or not good:
        LIMIT.add(ipk)
        LIMIT.add(uk)
        msg = 'That user name and password do not match.'
        if form:
            return h.send(401, login_page(msg, name, nxt), 'text/html; charset=utf-8', headers=studio_headers())
        raise ApiError(401, msg)
    LIMIT.clear(uk)
    tok = secrets.token_urlsafe(32)
    now = int(time.time())
    c = db()
    c.execute('INSERT INTO sessions (hash, user_id, created, expires, last_seen) VALUES (?,?,?,?,?)',
              (hashlib.sha256(tok.encode()).hexdigest(), row['id'], now, now + SESSION_DAYS * 86400, now))
    c.execute('UPDATE users SET last_login = ? WHERE id = ?', (now, row['id']))
    c.execute('DELETE FROM sessions WHERE expires < ?', (now,))
    audit(row['id'], 'login')
    cookie = h.cookie_header(tok, SESSION_DAYS * 86400)
    if form:
        return h.redirect(nxt, {'Set-Cookie': cookie})
    h.send(200, {'ok': True, 'name': row['name'], 'next': nxt}, headers={'Set-Cookie': cookie})


@route('POST', r'/api/studio/logout', auth=True)
def api_logout(h, user):
    db().execute('DELETE FROM sessions WHERE hash = ?', (user['hash'],))
    h.send(200, {'ok': True}, headers={'Set-Cookie': h.cookie_header('', 0)})


@route('GET', r'/api/studio/me', auth=True)
def api_me(h, user):
    h.ok({'name': user['name']})


# ---------------------------------------------------------------- studio pages
@route('GET', r'/studio', auth=True)
def page_studio_bare(h, user):
    h.redirect('/studio/')


@route('GET', r'/studio/', auth=True)
def page_studio(h, user):
    h.send(200, studio_page('Your videos', 'list', user,
                            attrs=' data-origin="%s" data-chunk="%d"' % (html.escape(ORIGIN), CHUNK),
                            main='<div class="wrap"><p class="loading-line">Loading your videos…</p></div>'),
           'text/html; charset=utf-8', headers=studio_headers())


@route('GET', r'/studio/v/([a-z0-9-]+)', auth=True)
def page_studio_video(h, user, slug):
    v = L.find(MAN.get(), slug)
    if not v or v.get('processing'):
        return h.send(404, studio_page('Not found', 'missing', user, main=(
            '<div class="wrap"><div class="empty empty-page"><h1>No video called %s</h1>'
            '<p><a class="btn btn-primary" href="/studio/">Back to your videos</a></p></div></div>') % html.escape(slug)),
            'text/html; charset=utf-8', headers=studio_headers())
    h.send(200, studio_page(v['title'], 'video', user, attrs=' data-slug="%s" data-origin="%s"' % (
        html.escape(slug), html.escape(ORIGIN)), main='<div class="wrap"><p class="loading-line">Loading…</p></div>'),
        'text/html; charset=utf-8', headers=studio_headers())


@route('GET', r'/studio/media/([a-z0-9-]+)/([A-Za-z0-9._-]+)', auth=True)
def studio_media(h, user, slug, name):
    v = L.find(MAN.get(), slug)
    if not v or not FILE_RE.match(name) or name.endswith('.removed'):
        raise ApiError(404, 'Not found.')
    d = L.video_dir(v)
    if not os.path.isfile(os.path.join(d, name)):
        raise ApiError(404, 'Not found.')
    if L.in_store(v):
        target = '/_store/%s/%s' % (slug, name)
    else:
        target = L.page_path(v) + name
    ctype = {'mp4': 'video/mp4', 'jpg': 'image/jpeg', 'vtt': 'text/vtt'}.get(name.rsplit('.', 1)[-1], 'application/octet-stream')
    h.send(200, b'', ctype, headers={'X-Accel-Redirect': target, 'Cache-Control': 'private, no-store'})


# ---------------------------------------------------------------- studio API: library
@route('GET', r'/api/studio/library', auth=True)
def api_library(h, user):
    data = MAN.get()
    vids = [v for v in data['videos'] if not v.get('processing')]
    counts = counts_for([v['slug'] for v in vids])
    h.ok({'videos': [video_summary(v, counts) for v in sorted(vids, key=lambda v: (v.get('date', ''), v.get('added', '')), reverse=True)],
          'folders': [{'slug': f['slug'], 'title': f['title']} for f in sorted(data['folders'], key=lambda f: (f.get('order', 99), f['title']))],
          'jobs': job_rows()})


@route('GET', r'/api/studio/jobs', auth=True)
def api_jobs(h, user):
    h.ok({'jobs': job_rows()})


@route('POST', r'/api/studio/jobs/(\d+)/retry', auth=True)
def api_job_retry(h, user, jid):
    c = db()
    row = c.execute('SELECT * FROM jobs WHERE id = ?', (int(jid),)).fetchone()
    if not row or row['status'] != 'failed':
        raise ApiError(400, 'Only a failed job can be retried.')
    if not os.path.exists(upload_path(row['upload_id'])):
        raise ApiError(400, 'The uploaded file is no longer there. Upload it again.')
    c.execute("UPDATE jobs SET status='queued', message='', stage='', progress=0, updated=? WHERE id=?",
              (int(time.time()), row['id']))
    _job_wake.set()
    h.ok({'ok': True})


@route('POST', r'/api/studio/folders', auth=True)
def api_folder_new(h, user):
    b = h.json_body()
    f = ops.create_folder(str(b.get('title') or ''), str(b.get('desc') or ''))
    audit(user['id'], 'folder', None, f['slug'])
    h.ok({'folder': {'slug': f['slug'], 'title': f['title']}})


def _video(slug):
    v = L.find(MAN.get(), slug)
    if not v or v.get('processing'):
        raise ApiError(404, 'No video called %s.' % slug)
    return v


@route('GET', r'/api/studio/videos/([a-z0-9-]+)', auth=True)
def api_video(h, user, slug):
    v = _video(slug)
    base = '/studio/media/%s/' % slug
    data = MAN.get()
    h.ok({'video': dict(video_summary(v, counts_for([slug])), captions=v.get('captions', []),
                        renditions=[{'height': r['height'], 'bytes': r['bytes']} for r in v.get('renditions', [])],
                        source=(v.get('source') or {}).get('name'), token=v.get('token')),
          'player': build.player_config(v, base=base),
          'poster_big': base + v['poster']['file'] + '?v=' + build.stamp(v),
          'links': links_for(v), 'analytics': analytics(v),
          'folders': [{'slug': f['slug'], 'title': f['title']} for f in sorted(data['folders'], key=lambda f: (f.get('order', 99), f['title']))]})


@route('PATCH', r'/api/studio/videos/([a-z0-9-]+)', auth=True)
def api_video_edit(h, user, slug):
    _video(slug)
    b = h.json_body()
    fields = {k: (str(b[k]) if b.get(k) is not None else None) for k in ('title', 'desc', 'date', 'folder', 'visibility')}
    v = ops.update(slug, **fields)
    audit(user['id'], 'edit', slug, ','.join(k for k, x in fields.items() if x is not None))
    forget_count(slug)
    h.ok({'ok': True, 'video': video_summary(v, counts_for([slug])), 'links': links_for(v)})


@route('POST', r'/api/studio/videos/([a-z0-9-]+)/trash', auth=True)
def api_trash(h, user, slug):
    _video(slug)
    ops.trash(slug)
    audit(user['id'], 'trash', slug)
    h.ok({'ok': True})


@route('POST', r'/api/studio/videos/([a-z0-9-]+)/restore', auth=True)
def api_restore(h, user, slug):
    _video(slug)
    ops.restore(slug)
    audit(user['id'], 'restore', slug)
    h.ok({'ok': True})


@route('POST', r'/api/studio/videos/([a-z0-9-]+)/poster', auth=True)
def api_poster(h, user, slug):
    _video(slug)
    ctype = (h.headers.get('Content-Type') or '').split(';')[0].strip()
    if ctype in ('image/jpeg', 'image/png', 'image/webp'):
        raw = h.read_body(12 * 1024 * 1024)
        tmp = os.path.join(L.UPLOAD_ROOT, 'poster-%s.%s' % (secrets.token_hex(6), ctype.split('/')[1]))
        os.makedirs(L.UPLOAD_ROOT, mode=0o700, exist_ok=True)
        with open(tmp, 'wb') as f:
            f.write(raw)
        try:
            ops.set_poster(slug, image=tmp)
        finally:
            os.remove(tmp)
    else:
        b = h.json_body()
        try:
            t = float(b.get('t'))
        except (TypeError, ValueError):
            raise ApiError(400, 'Pick a moment in the video first.')
        ops.set_poster(slug, at=t)
    audit(user['id'], 'poster', slug)
    v = _video(slug)
    h.ok({'ok': True, 'poster': '/studio/media/%s/%s?v=%s' % (slug, v['poster']['file'], build.stamp(v))})


@route('PUT', r'/api/studio/videos/([a-z0-9-]+)/captions', auth=True)
def api_captions(h, user, slug):
    _video(slug)
    raw = h.read_body(4 * 1024 * 1024)
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ApiError(400, 'The captions file must be UTF-8 text.')
    v = ops.set_captions(slug, text, h.query.get('lang') or 'en', h.query.get('label') or 'English')
    audit(user['id'], 'captions', slug, h.query.get('lang') or 'en')
    h.ok({'ok': True, 'captions': v['captions']})


@route('DELETE', r'/api/studio/videos/([a-z0-9-]+)/captions', auth=True)
def api_captions_off(h, user, slug):
    _video(slug)
    v = ops.remove_captions(slug, h.query.get('lang') or 'en')
    audit(user['id'], 'captions-off', slug, h.query.get('lang') or 'en')
    h.ok({'ok': True, 'captions': v['captions']})


# ---------------------------------------------------------------- studio API: uploads (chunked, resumable)
def upload_row(uid, user):
    row = db().execute('SELECT * FROM uploads WHERE id = ?', (uid,)).fetchone()
    if not row or row['user_id'] != user['id']:
        raise ApiError(404, 'No such upload.')
    return row


def upload_json(row):
    job = db().execute('SELECT id, status FROM jobs WHERE upload_id = ? ORDER BY id DESC LIMIT 1', (row['id'],)).fetchone()
    return {'id': row['id'], 'name': row['name'], 'size': row['size'], 'received': row['received'],
            'status': row['status'], 'chunk': CHUNK, 'meta': json.loads(row['meta']) if row['meta'] else None,
            'job': job['id'] if job else None}


@route('POST', r'/api/studio/uploads', auth=True)
def api_upload_new(h, user):
    b = h.json_body()
    name = str(b.get('name') or '').strip()[:200] or 'video'
    try:
        size = int(b.get('size'))
    except (TypeError, ValueError):
        raise ApiError(400, 'The file size is missing.')
    if size <= 0:
        raise ApiError(400, 'That file is empty.')
    if size > MAX_UPLOAD:
        raise ApiError(413, 'That file is larger than 50 GB.')
    ctype = str(b.get('type') or '')
    if ctype and not (ctype.startswith('video/') or ctype in ('application/octet-stream', 'application/mxf')):
        raise ApiError(400, 'That is not a video file.')
    os.makedirs(L.UPLOAD_ROOT, mode=0o700, exist_ok=True)
    if shutil.disk_usage(L.UPLOAD_ROOT).free < size * 3 + 2 * 1024 ** 3:
        raise ApiError(507, 'There is not enough disk space on the server for this file.')
    fp = hashlib.sha256(('%s|%d|%s' % (name, size, b.get('lastModified'))).encode()).hexdigest()[:32]
    c = db()
    row = c.execute("SELECT * FROM uploads WHERE user_id = ? AND fingerprint = ? AND status = 'uploading' "
                    "ORDER BY created DESC LIMIT 1", (user['id'], fp)).fetchone()
    if row and os.path.exists(upload_path(row['id'])):
        real = os.path.getsize(upload_path(row['id']))
        if real != row['received']:
            c.execute('UPDATE uploads SET received = ? WHERE id = ?', (real, row['id']))
            row = upload_row(row['id'], user)
        return h.ok({'upload': upload_json(row), 'resumed': True})
    uid = secrets.token_hex(12)
    now = int(time.time())
    fd = os.open(upload_path(uid), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    c.execute('INSERT INTO uploads (id, user_id, name, size, fingerprint, created, updated) VALUES (?,?,?,?,?,?,?)',
              (uid, user['id'], name, size, fp, now, now))
    h.ok({'upload': upload_json(upload_row(uid, user)), 'resumed': False})


@route('GET', r'/api/studio/uploads/([0-9a-f]{24})', auth=True)
def api_upload_get(h, user, uid):
    h.ok({'upload': upload_json(upload_row(uid, user))})


_upload_locks = {}
_upload_locks_lock = threading.Lock()


@route('PUT', r'/api/studio/uploads/([0-9a-f]{24})', auth=True)
def api_upload_chunk(h, user, uid):
    with _upload_locks_lock:
        lk = _upload_locks.setdefault(uid, threading.Lock())
    with lk:
        row = upload_row(uid, user)
        if row['status'] != 'uploading':
            raise ApiError(409, 'This upload is already complete.', {'received': row['received']})
        try:
            offset = int(h.query.get('offset'))
        except (TypeError, ValueError):
            raise ApiError(400, 'The chunk offset is missing.')
        if offset != row['received']:
            raise ApiError(409, 'The server has a different amount of this file.', {'received': row['received']})
        data = h.read_body(MAX_CHUNK)
        if not data or offset + len(data) > row['size']:
            raise ApiError(400, 'That chunk does not fit the file.')
        path = upload_path(uid)
        with open(path, 'r+b') as f:
            f.seek(offset)
            f.write(data)
            f.truncate()
        received = offset + len(data)
        db().execute('UPDATE uploads SET received=?, updated=? WHERE id=?', (received, int(time.time()), uid))
        job = maybe_queue(uid)
    h.ok({'received': received, 'job': job})


VIS_OK = set(L.VISIBILITIES)


@route('POST', r'/api/studio/uploads/([0-9a-f]{24})/meta', auth=True)
def api_upload_meta(h, user, uid):
    row = upload_row(uid, user)
    if row['status'] not in ('uploading',):
        raise ApiError(409, 'This upload is already being processed.')
    b = h.json_body()
    title = str(b.get('title') or '').strip()
    if not title:
        raise ApiError(400, 'Give the video a title.')
    if len(title) > 200:
        raise ApiError(400, 'The title is longer than 200 characters.')
    vis = str(b.get('visibility') or 'private')
    if vis not in VIS_OK:
        raise ApiError(400, 'Choose who can see the video.')
    folder = str(b.get('folder') or 'pre-read')
    if not any(f['slug'] == folder for f in MAN.get()['folders']):
        raise ApiError(400, 'Choose a folder.')
    date = str(b.get('date') or '') or None
    if date:
        try:
            datetime.date.fromisoformat(date)
        except ValueError:
            raise ApiError(400, 'The date must look like 2026-10-27.')
    desc = str(b.get('desc') or '')[:5000]
    meta = {'title': title, 'desc': desc, 'folder': folder, 'visibility': vis, 'date': date}
    db().execute('UPDATE uploads SET meta=?, updated=? WHERE id=?', (json.dumps(meta), int(time.time()), uid))
    job = maybe_queue(uid)
    h.ok({'ok': True, 'job': job, 'upload': upload_json(upload_row(uid, user))})


@route('DELETE', r'/api/studio/uploads/([0-9a-f]{24})', auth=True)
def api_upload_cancel(h, user, uid):
    """Stop an unfinished transfer. The partial file is a piece of a transfer, not a video, so it goes."""
    row = upload_row(uid, user)
    if row['status'] != 'uploading':
        raise ApiError(409, 'This upload is already being processed.')
    db().execute("UPDATE uploads SET status='cancelled', updated=? WHERE id=?", (int(time.time()), uid))
    try:
        os.remove(upload_path(uid))
    except FileNotFoundError:
        pass
    h.ok({'ok': True})


# ---------------------------------------------------------------- main
def main():
    global DUMMY_HASH
    os.umask(0o022)
    secret()
    init_db()
    recover_jobs()
    DUMMY_HASH = hash_password(secrets.token_hex(16))
    os.makedirs(L.UPLOAD_ROOT, mode=0o700, exist_ok=True)
    threading.Thread(target=job_worker, name='jobs', daemon=True).start()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    print('joya-library listening on %s:%d (site %s, origin %s)' % (BIND, PORT, L.SITE_ROOT, ORIGIN), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
