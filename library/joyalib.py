"""Shared bits of the JOYA Library tools: where things live, the manifest, slugs, safe writes,
visibility and the place each video's files live.

The manifest (the list of folders and videos) is data, not code, so it lives outside the repo:
  JOYA_LIBRARY_MANIFEST  default /var/lib/joya-library/library.json
The public site is written to:
  JOYA_LIBRARY_ROOT      default /var/www/library
and its links point at:
  JOYA_LIBRARY_URL       default https://library.example.com
Private and trashed videos, uploads, the database and the secret live next to the manifest:
  JOYA_LIBRARY_STORE     default <manifest dir>/store       (served to the studio only)
  JOYA_LIBRARY_DB        default <manifest dir>/library.db
  JOYA_LIBRARY_SECRET    default <manifest dir>/secret.key

Visibility (like YouTube):
  public    /<folder>/<slug>/             listed on the home page, in its folder, in Up next
  unlisted  /u/<token>/<slug>/            reachable only by that link; never listed anywhere
  private   <store>/<slug>/               studio only
A trashed video keeps its files in <store>/<slug>/ and can be restored from the studio.
"""
import contextlib
import fcntl
import json
import os
import pwd
import re
import secrets
import shutil
import tempfile
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SITE_ROOT = os.environ.get('JOYA_LIBRARY_ROOT', '/var/www/library')
MANIFEST = os.environ.get('JOYA_LIBRARY_MANIFEST', '/var/lib/joya-library/library.json')
BASE_URL = os.environ.get('JOYA_LIBRARY_URL', 'https://library.example.com').rstrip('/')
STATE_DIR = os.path.dirname(os.path.abspath(MANIFEST))
STORE_ROOT = os.environ.get('JOYA_LIBRARY_STORE', os.path.join(STATE_DIR, 'store'))
DB_PATH = os.environ.get('JOYA_LIBRARY_DB', os.path.join(STATE_DIR, 'library.db'))
SECRET_PATH = os.environ.get('JOYA_LIBRARY_SECRET', os.path.join(STATE_DIR, 'secret.key'))
UPLOAD_ROOT = os.environ.get('JOYA_LIBRARY_UPLOADS', os.path.join(STATE_DIR, 'uploads'))
SOURCE_ROOT = os.path.join(STATE_DIR, 'sources')
OWNER = os.environ.get('JOYA_LIBRARY_OWNER', 'joyalib')

SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
TOKEN_RE = re.compile(r'^[0-9a-f]{24}$')
VISIBILITIES = ('public', 'unlisted', 'private')
# Top-level names a folder may not take (they are routes or system folders).
RESERVED = {'u', 'embed', 'assets', 'studio', 'api', '_store', '404', 'index', 'favicon', 'robots', 'sitemap'}

DEFAULT_FOLDERS = [
    {'slug': 'pre-read', 'title': 'Pre-read', 'order': 0,
     'desc': 'Short films to watch before a meeting.'},
]


def slugify(text):
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'[^a-zA-Z0-9]+', '-', text).strip('-').lower()
    return re.sub(r'-{2,}', '-', text)[:80].strip('-') or 'video'


def folder_title(slug):
    t = slug.replace('-', ' ').strip()
    return t[:1].upper() + t[1:] if t else slug


def new_token():
    return secrets.token_hex(12)


# ---------------------------------------------------------------- ownership
_owner = None


def owner_ids():
    """(uid, gid) of the service user when we run as root and it exists, else None."""
    global _owner
    if _owner is None:
        _owner = False
        if os.geteuid() == 0:
            try:
                pw = pwd.getpwnam(OWNER)
                _owner = (pw.pw_uid, pw.pw_gid)
            except KeyError:
                pass
    return _owner or None


def chown(path):
    ids = owner_ids()
    if ids:
        try:
            os.chown(path, *ids)
        except OSError:
            pass


def chown_tree(path):
    if not owner_ids() or not os.path.exists(path):
        return
    chown(path)
    for d, dirs, files in os.walk(path):
        for n in dirs + files:
            chown(os.path.join(d, n))


# ---------------------------------------------------------------- manifest
@contextlib.contextmanager
def locked():
    """One writer at a time across the CLI and the studio service."""
    os.makedirs(STATE_DIR, exist_ok=True)
    path = MANIFEST + '.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    chown(path)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def migrate(data):
    """Fill fields added after the first version. Returns True when something changed."""
    changed = False
    for v in data['videos']:
        if v.get('visibility') not in VISIBILITIES:
            v['visibility'] = 'public'
            changed = True
        if not TOKEN_RE.match(v.get('token') or ''):
            v['token'] = new_token()
            changed = True
    data.setdefault('moved', [])
    return changed


def load():
    if not os.path.exists(MANIFEST):
        data = {'version': 2, 'folders': [dict(f) for f in DEFAULT_FOLDERS], 'videos': [], 'moved': []}
        return data
    with open(MANIFEST, encoding='utf-8') as f:
        data = json.load(f)
    data.setdefault('folders', [dict(f) for f in DEFAULT_FOLDERS])
    data.setdefault('videos', [])
    if migrate(data):
        data['version'] = 2
        save(data)
    return data


def save(data):
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    if os.path.exists(MANIFEST):
        shutil.copy2(MANIFEST, MANIFEST + '.bak')
        chown(MANIFEST + '.bak')
    write_text(MANIFEST, json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def write_text(path, text, mode=0o644):
    """Atomic, world-readable write (nginx runs as www-data)."""
    d = os.path.dirname(path)
    makedirs(d)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, mode)
    chown(tmp)
    os.replace(tmp, path)


def makedirs(path, mode=0o755):
    os.makedirs(path, exist_ok=True)
    # Every directory between the site (or store) root and the path must be traversable by nginx.
    p = os.path.abspath(path)
    roots = [os.path.abspath(SITE_ROOT), os.path.abspath(STORE_ROOT)]
    while True:
        inside = any(p == r or p.startswith(r + os.sep) for r in roots)
        if not inside:
            break
        try:
            os.chmod(p, mode)
            chown(p)
        except PermissionError:
            break
        if p in roots:
            break
        p = os.path.dirname(p)


def _inside(root, path):
    root = os.path.realpath(root)
    real = os.path.realpath(path)
    return real != root and real.startswith(root + os.sep)


def inside_site(path):
    return _inside(SITE_ROOT, path)


def remove_tree(path):
    """Delete a generated directory (pages, embeds), but only one inside the site root."""
    if not inside_site(path):
        raise SystemExit('refusing to delete outside %s: %s' % (SITE_ROOT, path))
    if os.path.isdir(path):
        shutil.rmtree(path)


# ---------------------------------------------------------------- where a video lives
def is_public(v):
    return v.get('visibility', 'public') == 'public' and not v.get('trashed')


def is_unlisted(v):
    return v.get('visibility') == 'unlisted' and not v.get('trashed')


def in_store(v):
    return bool(v.get('trashed')) or v.get('visibility') == 'private'


def video_dir(v):
    """Directory holding the video's files and (when it has one) its page."""
    if in_store(v):
        return os.path.join(STORE_ROOT, v['slug'])
    if v.get('visibility') == 'unlisted':
        return os.path.join(SITE_ROOT, 'u', v['token'], v['slug'])
    return os.path.join(SITE_ROOT, v['folder'], v['slug'])


def page_path(v):
    """Public URL path of the watch page, or None when it has none (private, trashed)."""
    if in_store(v):
        return None
    if v.get('visibility') == 'unlisted':
        return '/u/%s/%s/' % (v['token'], v['slug'])
    return '/%s/%s/' % (v['folder'], v['slug'])


def embed_path(v):
    if in_store(v):
        return None
    if v.get('visibility') == 'unlisted':
        return '/u/%s/%s/embed/' % (v['token'], v['slug'])
    return '/embed/%s/' % v['slug']


def stats_key(v):
    """The key a page uses to ask for and report its counts: the slug, or u:<token> when unlisted."""
    return ('u:' + v['token']) if v.get('visibility') == 'unlisted' else v['slug']


def relocate(old_dir, v):
    """Move a video's files to where its visibility (and folder) now says they belong."""
    new_dir = video_dir(v)
    if os.path.abspath(old_dir) == os.path.abspath(new_dir):
        return new_dir
    if os.path.exists(new_dir):
        raise SystemExit('target already exists: %s' % new_dir)
    makedirs(os.path.dirname(new_dir))
    if os.path.isdir(old_dir):
        shutil.move(old_dir, new_dir)
    else:
        makedirs(new_dir)
    os.chmod(new_dir, 0o755)
    # Drop the page and embed generated for the old place; build.py writes the new ones.
    for stale in ('index.html',):
        p = os.path.join(new_dir, stale)
        if os.path.exists(p):
            os.remove(p)
    emb = os.path.join(new_dir, 'embed')
    if os.path.isdir(emb):
        shutil.rmtree(emb)
    prune_empty(os.path.dirname(old_dir))
    return new_dir


def prune_empty(d):
    """Remove empty folders left behind under /u/ (a token folder) or the store."""
    d = os.path.abspath(d)
    stop = {os.path.abspath(SITE_ROOT), os.path.abspath(STORE_ROOT), os.path.join(os.path.abspath(SITE_ROOT), 'u')}
    while d not in stop and (_inside(SITE_ROOT, d) or _inside(STORE_ROOT, d)):
        try:
            os.rmdir(d)
        except OSError:
            break
        d = os.path.dirname(d)


def unique_slug(data, base):
    taken = {v['slug'] for v in data['videos']}
    if base not in taken and base != 'embed':
        return base
    i = 2
    while '%s-%d' % (base, i) in taken:
        i += 1
    return '%s-%d' % (base, i)


def find(data, slug):
    return next((v for v in data['videos'] if v['slug'] == slug), None)


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
