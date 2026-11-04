#!/usr/bin/env python3
"""Rebuild every page of the JOYA Library from the manifest.

  python3 library/build.py

Writes into /var/www/library:
  index.html                 every public video, folder chips, search, sort, Continue watching
  <folder>/index.html        the same grid for one folder
  <folder>/<slug>/index.html the watch page of a public video
  embed/<slug>/index.html    its player alone, for an iframe
  u/<token>/<slug>/          the watch page and embed of an unlisted video (never listed anywhere)
  404.html, assets/
Media files are left alone (pipeline.py makes them). Safe to run any time.
"""
import hashlib
import html
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joyalib as L  # noqa: E402

ASSETS = {  # published name -> source in the repo
    'player.js': 'library/player/player.js',
    'player.css': 'library/player/player.css',
    'site.css': 'library/site/site.css',
    'site.js': 'library/site/site.js',
    'count.js': 'library/site/count.js',
    'studio.css': 'library/studio/studio.css',
    'studio.js': 'library/studio/studio.js',
    'favicon.svg': 'dashboard/public/brand/m/favicon.svg',
    'favicon.ico': 'dashboard/public/brand/m/favicon.ico',
    'fonts/next-400.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2',
    'fonts/next-600.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-600-normal.woff2',
    'fonts/next-700.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-700-normal.woff2',
    'fonts/next-800.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-next-latin-800-normal.woff2',
    'fonts/mono-400.woff2': 'dashboard/public/fonts/atkinson-hyperlegible-mono-latin-400-normal.woff2',
    'fonts/OFL-AtkinsonHyperlegibleNext.txt': 'dashboard/public/fonts/OFL-AtkinsonHyperlegibleNext.txt',
    'fonts/OFL-AtkinsonHyperlegibleMono.txt': 'dashboard/public/fonts/OFL-AtkinsonHyperlegibleMono.txt',
}
VER = {}
E = html.escape
MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()

ICONS = {
    'search': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    'share': '<path d="M14 5l7 7-7 7"/><path d="M21 12H11a8 8 0 0 0-8 8"/>',
    'download': '<path d="M12 3v12M6.5 9.5L12 15l5.5-5.5"/><path d="M4 20h16"/>',
    'back': '<path d="M15 5l-7 7 7 7"/>',
    'caret': '<path d="M7 10l5 5 5-5"/>',
    'folder': '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
    'play': '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    'close': '<path d="M6 6l12 12M18 6L6 18"/>',
}


def icon(name, size=20):
    return ('<svg class="i" viewBox="0 0 24 24" width="%d" height="%d" aria-hidden="true" focusable="false" fill="none" '
            'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">%s</svg>'
            % (size, size, ICONS[name]))


def asset(name):
    return '/assets/%s?v=%s' % (name, VER.get(name, '0'))


def copy_assets():
    dst_root = os.path.join(L.SITE_ROOT, 'assets')
    L.makedirs(os.path.join(dst_root, 'fonts'))
    for name, src in ASSETS.items():
        src = os.path.join(L.REPO, src)
        with open(src, 'rb') as f:
            body = f.read()
        VER[name] = hashlib.sha1(body).hexdigest()[:10]
        dst = os.path.join(dst_root, name)
        tmp = dst + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.chmod(tmp, 0o644)
        L.chown(tmp)
        os.replace(tmp, dst)
    os.chmod(os.path.join(dst_root, 'fonts'), 0o755)


def ensure_versions():
    """Asset versions without writing (the studio service renders pages that link the assets)."""
    if VER:
        return
    for name, src in ASSETS.items():
        try:
            with open(os.path.join(L.REPO, src), 'rb') as f:
                VER[name] = hashlib.sha1(f.read()).hexdigest()[:10]
        except OSError:
            VER[name] = '0'


def fdate(iso):
    y, m, d = iso[:10].split('-')
    return '%d %s %s' % (int(d), MONTHS[int(m) - 1], y)


def fdur(sec):
    s = int(round(sec))
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return '%d:%02d:%02d' % (h, m, s) if h else '%d:%02d' % (m, s)


def fdur_words(sec):
    s = int(round(sec))
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    parts = []
    if h:
        parts.append('%d hour%s' % (h, '' if h == 1 else 's'))
    if m:
        parts.append('%d minute%s' % (m, '' if m == 1 else 's'))
    if s or not parts:
        parts.append('%d second%s' % (s, '' if s == 1 else 's'))
    return ' '.join(parts)


def fsize(b):
    if b >= 1e9:
        return '%.1f GB' % (b / 1e9)
    return '%.0f MB' % (b / 1e6) if b >= 1e7 else '%.1f MB' % (b / 1e6)


def vurl(v, absolute=False):
    p = L.page_path(v)
    return L.BASE_URL + p if absolute else p


def media(v, name, absolute=False, base=None):
    return (base or vurl(v, absolute)) + name


def stamp(v):
    return v.get('updated', '')[:19].replace(':', '').replace('-', '')


def head(title, desc, url, image=None, video=None, og_type='website', extra=''):
    tags = [
        '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<title>%s</title>' % E(title),
        '<meta name="description" content="%s">' % E(desc[:300]),
        '<meta name="robots" content="noindex, nofollow">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        '<meta name="color-scheme" content="light dark">',
        '<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">',
        '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">',
        '<link rel="icon" href="%s" type="image/svg+xml">' % asset('favicon.svg'),
        '<link rel="alternate icon" href="%s" sizes="32x32">' % asset('favicon.ico'),
        '<link rel="preload" href="%s" as="font" type="font/woff2" crossorigin>' % asset('fonts/next-400.woff2'),
        '<meta property="og:site_name" content="JOYA Library">',
        '<meta property="og:type" content="%s">' % og_type,
        '<meta property="og:title" content="%s">' % E(title.split(' · ')[0]),
        '<meta property="og:description" content="%s">' % E(desc[:300]),
        '<meta property="og:url" content="%s">' % E(url),
    ]
    if image:
        tags += [
            '<meta property="og:image" content="%s">' % E(image['url']),
            '<meta property="og:image:secure_url" content="%s">' % E(image['url']),
            '<meta property="og:image:type" content="image/jpeg">',
            '<meta property="og:image:width" content="%d">' % image['width'],
            '<meta property="og:image:height" content="%d">' % image['height'],
            '<meta property="og:image:alt" content="%s">' % E(image['alt']),
            '<meta name="twitter:card" content="summary_large_image">',
            '<meta name="twitter:image" content="%s">' % E(image['url']),
        ]
    if video:
        tags += [
            '<meta property="og:video" content="%s">' % E(video['url']),
            '<meta property="og:video:secure_url" content="%s">' % E(video['url']),
            '<meta property="og:video:type" content="video/mp4">',
            '<meta property="og:video:width" content="%d">' % video['width'],
            '<meta property="og:video:height" content="%d">' % video['height'],
            '<meta property="video:duration" content="%d">' % int(round(video['duration'])),
        ]
    tags += ['<meta name="twitter:title" content="%s">' % E(title.split(' · ')[0]),
             '<meta name="twitter:description" content="%s">' % E(desc[:300])]
    tags.append(extra)
    tags.append('</head>')
    return '\n'.join(t for t in tags if t)


def topbar(q_value=''):
    return (
        '<a class="skip-link" href="#main">Skip to the content</a>\n'
        '<header class="topbar"><div class="topbar-in">'
        '<a class="brand" href="/" aria-label="JOYA Library, home">'
        '<span class="wordmark"><span class="wm-joya">JOYA</span><span class="wm-sub">Library</span></span></a>'
        '<form class="topsearch" id="topsearch" role="search" action="/" method="get">'
        '<button type="button" class="icon-btn search-back" id="search-back" aria-label="Close search">%s</button>'
        '<label class="sr" for="tq">Search videos</label>'
        '<input id="tq" name="q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" '
        'enterkeyhint="search" value="%s">'
        '<button class="topsearch-btn" type="submit" aria-label="Search">%s</button></form>'
        '<div class="topbar-end">'
        '<button type="button" class="icon-btn search-open" id="search-open" aria-label="Search" '
        'aria-controls="topsearch" aria-expanded="false">%s</button>'
        '<a class="toplink" href="/studio/">Studio</a></div>'
        '</div></header>') % (icon('back'), E(q_value), icon('search'), icon('search'))


def footer():
    return ('<footer class="foot"><p>Anyone with a link can watch. These pages are not listed in search engines.</p>'
            '</footer>')


def card(v, folders, show_folder=True, heading='h3', compact=False):
    p = v['poster']
    f = folders.get(v['folder'])
    key = L.stats_key(v)
    folder_line = ''
    if show_folder and f and not compact:
        folder_line = '<p class="card-folder"><a href="/%s/">%s</a></p>' % (f['slug'], E(f['title']))
    elif compact and f:
        folder_line = '<p class="card-folder">%s</p>' % E(f['title'])
    return (
        '<li class="card%(cls)s" data-id="%(key)s" data-date="%(date)s" data-added="%(added)s" data-title="%(tkey)s" '
        'data-dur="%(dur).3f" data-text="%(text)s" data-folder="%(folder)s">'
        '<a class="thumb" href="%(url)s" tabindex="-1" aria-hidden="true">'
        '<img src="%(img)s" width="640" height="%(ih)d" alt="" loading="lazy" decoding="async">'
        '<span class="badge">%(fd)s</span><span class="watched" hidden><span class="watched-bar"></span></span></a>'
        '<div class="card-body"><%(h)s class="card-title"><a href="%(url)s">%(title)s'
        '<span class="sr">, %(fdw)s</span></a></%(h)s>%(folder_line)s'
        '<p class="card-meta"><span class="views" data-views-for="%(key)s"></span>'
        '<span class="sep" aria-hidden="true">·</span>'
        '<time class="rel" datetime="%(date)s">%(fdate)s</time></p></div></li>'
    ) % {
        'cls': ' card-compact' if compact else '', 'key': E(key),
        'date': E(v['date']), 'added': E(v.get('added', '')), 'tkey': E(v['title'].lower()),
        'dur': v['duration'], 'text': E((v['title'] + ' ' + v.get('desc', '') + ' ' + (f['title'] if f else '')).lower()),
        'folder': E(v['folder']),
        'url': vurl(v), 'img': media(v, p['small']) + '?v=' + stamp(v),
        'ih': int(round(640 * p['height'] / float(p['width']))),
        'fd': fdur(v['duration']), 'fdw': fdur_words(v['duration']), 'h': heading, 'title': E(v['title']),
        'fdate': fdate(v['date']), 'folder_line': folder_line,
    }


def newest(videos):
    return sorted(videos, key=lambda v: (v['date'], v.get('added', '')), reverse=True)


def player_config(v, base=None, theater=False):
    cfg = {
        'id': v['slug'], 'title': v['title'], 'duration': v['duration'],
        'poster': media(v, v['poster']['file'], base=base) + '?v=' + stamp(v),
        'sources': [{'h': r['height'], 'w': r['width'], 'src': media(v, r['file'], base=base), 'bytes': r['bytes']}
                    for r in sorted(v['renditions'], key=lambda r: -r['height'])],
        'thumbs': media(v, v['sprite']['vtt'], base=base) if v.get('sprite') else None,
        'captions': [{'src': media(v, c['file'], base=base), 'lang': c['lang'], 'label': c['label']}
                     for c in v.get('captions', [])],
    }
    if theater:
        cfg['theater'] = True
    return cfg


def player_html(v, embed=False, base=None, theater=False):
    cfg = json.dumps(player_config(v, base, theater), separators=(',', ':'), ensure_ascii=False)
    first = sorted(v['renditions'], key=lambda r: abs(r['height'] - 720))[0]
    w, h = v['width'], v['height']
    tracks = ''.join('<track kind="captions" src="%s" srclang="%s" label="%s">'
                     % (media(v, c['file'], base=base), E(c['lang']), E(c['label'])) for c in v.get('captions', []))
    return ('<div class="mlp%s" data-mlp="%s" style="--mlp-ar:%d/%d;--mlp-r:%.4f">'
            '<video class="mlp-video" controls playsinline preload="metadata" poster="%s" '
            'aria-label="Video: %s" width="%d" height="%d"><source src="%s" type="video/mp4">%s'
            '<a href="%s">Download the video</a></video></div>') % (
        ' mlp-embed' if embed else '', E(cfg, quote=True), w, h, w / float(h),
        media(v, v['poster']['file'], base=base) + '?v=' + stamp(v), E(v['title']),
        w, h, media(v, first['file'], base=base), tracks, media(v, first['file'], base=base))


def og_media(v):
    p = v['poster']
    og_r = sorted(v['renditions'], key=lambda r: abs(r['height'] - 720))[0]
    image = {'url': media(v, p['file'], True), 'width': p['width'], 'height': p['height'],
             'alt': 'Poster of the film %s' % v['title']}
    video = {'url': media(v, og_r['file'], True), 'width': og_r['width'], 'height': og_r['height'],
             'duration': v['duration']}
    return image, video


def css_links(player=False):
    out = '<link rel="stylesheet" href="%s">' % asset('site.css')
    if player:
        out += '\n<link rel="stylesheet" href="%s">' % asset('player.css')
    return out


def page(title, desc, url, body, image=None, video=None, og_type='website', player=False, cls='', attrs='',
         q_value=''):
    return '\n'.join([
        head(title, desc, url, image, video, og_type, css_links(player)),
        '<body class="%s"%s>' % (cls, attrs), topbar(q_value), '<main id="main" tabindex="-1">', body, '</main>',
        footer(),
        ('<script src="%s" defer></script>' % asset('player.js')) if player else '',
        '<script src="%s" defer></script>' % asset('site.js'),
        ('<script src="%s" defer></script>' % asset('count.js')) if player else '',
        '</body>', '</html>', ''])


def sort_box():
    return ('<div class="sortbox"><label for="sort">Sort by</label><span class="select">'
            '<select id="sort" name="sort">'
            '<option value="newest">Newest first</option><option value="views">Most viewed</option>'
            '<option value="oldest">Oldest first</option><option value="title">Title A–Z</option>'
            '<option value="longest">Longest</option></select>%s</span></div>') % icon('caret', 16)


def chips(folders_sorted, current):
    items = ['<li><a class="chip" href="/"%s>All</a></li>' % (' aria-current="page"' if current is None else '')]
    for f in folders_sorted:
        items.append('<li><a class="chip" href="/%s/"%s>%s</a></li>' % (
            f['slug'], ' aria-current="page"' if current == f['slug'] else '', E(f['title'])))
    return '<nav class="chips" aria-label="Folders"><ul role="list">%s</ul></nav>' % ''.join(items)


def listing(data, folders, vids, current=None):
    folders_sorted = [f for f in sorted(data['folders'], key=lambda f: (f.get('order', 99), f['title']))
                      if any(L.is_public(v) and v['folder'] == f['slug'] for v in data['videos']) or f['slug'] == current]
    n = len(vids)
    f = folders.get(current) if current else None
    if current:
        heading = '<h1 class="listing-title">%s</h1>%s' % (
            E(f['title']), ('<p class="lead">%s</p>' % E(f['desc'])) if f.get('desc') else '')
    else:
        heading = '<h1 class="sr" id="listing-h">All videos</h1>'
    no_match = ('<div class="empty" id="nomatch" hidden>%s<h2>No videos match <span id="nomatch-q"></span></h2>'
                '<p>Check the spelling, try fewer words, or look in every folder.</p>'
                '<p><a class="btn" href="/" id="clear-q">Show all videos</a></p></div>') % icon('search', 28)
    empty = ('<div class="empty">%s<h2>No videos here yet</h2><p>Videos shared %s will show up here, newest first.</p>'
             '%s</div>') % (icon('folder', 28), ('in %s' % E(f['title'])) if f else 'in the library',
                            '<p><a class="btn" href="/">See all videos</a></p>' if f else '')
    return (
        '<div class="wrap">%(heading)s'
        '<div class="filterbar">%(chips)s%(sort)s</div>'
        '<section class="shelf" id="cw" hidden aria-labelledby="cw-h"><div class="shelf-head">'
        '<h2 id="cw-h">Continue watching</h2></div><ul class="grid grid-shelf" id="cw-list" role="list"></ul></section>'
        '<div class="results-head" id="results-head" hidden><h2 id="results-h"></h2></div>'
        '<p class="count" id="count" aria-live="polite">%(count)s</p>'
        '<ul class="grid" id="grid" role="list"%(gattr)s>%(cards)s</ul>%(empty)s</div>'
    ) % {
        'heading': heading, 'chips': chips(folders_sorted, current), 'sort': sort_box() if n > 1 else '',
        'count': ('%d video%s' % (n, '' if n == 1 else 's')) if n else '',
        'gattr': ' data-home="1"' if not current else '',
        'cards': ''.join(card(v, folders, show_folder=not current) for v in vids),
        'empty': no_match if n else empty,
    }


def build_home(data, folders):
    vids = newest([v for v in data['videos'] if L.is_public(v)])
    body = listing(data, folders, vids)
    desc = 'Shared JOYA videos: %d so far.' % len(vids)
    image = og_media(vids[0])[0] if vids else None
    L.write_text(os.path.join(L.SITE_ROOT, 'index.html'),
                 page('JOYA Library', desc, L.BASE_URL + '/', body, image=image, cls='home'))


def build_folder(data, folders, f):
    vids = newest([v for v in data['videos'] if L.is_public(v) and v['folder'] == f['slug']])
    body = listing(data, folders, vids, current=f['slug'])
    n = len(vids)
    desc = f.get('desc') or ('%d video%s in %s.' % (n, '' if n == 1 else 's', f['title']))
    image = og_media(vids[0])[0] if vids else None
    L.write_text(os.path.join(L.SITE_ROOT, f['slug'], 'index.html'),
                 page('%s · JOYA Library' % f['title'], desc, '%s/%s/' % (L.BASE_URL, f['slug']), body,
                      image=image, cls='folder-page'))


def embed_code(v):
    return ('<iframe src="%s%s" width="960" height="540" title="%s" '
            'allow="fullscreen; picture-in-picture; autoplay; encrypted-media" allowfullscreen '
            'style="border:0;max-width:100%%;aspect-ratio:%d/%d;height:auto"></iframe>') % (
        L.BASE_URL, L.embed_path(v), E(v['title']), v['width'], v['height'])


def up_next(data, v):
    pub = newest([o for o in data['videos'] if L.is_public(o) and o['slug'] != v['slug']])
    same = [o for o in pub if o['folder'] == v['folder']]
    # In the same folder, the next one is the one after this video (older), then wrap around.
    if L.is_public(v):
        order = newest([o for o in data['videos'] if L.is_public(o) and o['folder'] == v['folder']])
        i = next((k for k, o in enumerate(order) if o['slug'] == v['slug']), 0)
        same = [o for o in order[i + 1:] + order[:i] if o['slug'] != v['slug']]
    rest = [o for o in pub if o['folder'] != v['folder']]
    return (same + rest)[:20]


def watch_body(data, folders, v, f):
    nxt = up_next(data, v)
    unlisted = L.is_unlisted(v)
    downloads = ''.join(
        '<li><a href="%s" download="%s" role="menuitem">%dp <span class="dl-size">%s · MP4</span></a></li>' % (
            media(v, r['file']), E('%s %dp.mp4' % (v['title'], r['height'])), r['height'], fsize(r['bytes']))
        for r in sorted(v['renditions'], key=lambda r: -r['height']))
    if nxt:
        side_list = '<ol class="side-list" role="list">%s</ol>' % ''.join(
            card(o, folders, heading='h3', compact=True) for o in nxt)
    else:
        side_list = '<p class="side-empty">This is the only video so far. <a href="/">Back to the library</a></p>'
    nxt0 = nxt[0] if nxt else None
    next_attr = ''
    if nxt0:
        next_attr = ' data-next="%s"' % E(json.dumps({
            'title': nxt0['title'], 'url': vurl(nxt0), 'poster': media(nxt0, nxt0['poster']['small']) + '?v=' + stamp(nxt0),
            'duration': fdur(nxt0['duration'])}, ensure_ascii=False), quote=True)
    vis_note = ('<p class="vis-note"><span class="shape" aria-hidden="true">◐</span> Unlisted: only people with '
                'the link can see this video.</p>') if unlisted else ''
    folder_link = ('<a href="/%s/">%s</a>' % (f['slug'], E(f['title']))) if L.is_public(v) else E(f['title'])
    desc = v.get('desc', '').strip()
    desc_html = ''.join('<p>%s</p>' % E(p).replace('\n', '<br>') for p in desc.split('\n\n') if p.strip()) \
        or '<p class="muted">No description.</p>'
    return (
        '<div class="watch" id="watch"%(next_attr)s>'
        '<div class="watch-stage">%(player)s</div>'
        '<div class="watch-main">'
        '%(vis_note)s<h1 class="watch-title">%(title)s</h1>'
        '<div class="watch-bar">'
        '<p class="watch-folder">%(icon_folder)s%(folder)s</p>'
        '<div class="actions">'
        '<button type="button" class="btn" id="share-btn" aria-expanded="false" aria-controls="share-panel">'
        '%(i_share)s<span>Share</span></button>'
        '<div class="menu-wrap" data-menu><button type="button" class="btn" aria-haspopup="menu" aria-expanded="false"'
        ' aria-controls="dl-menu">%(i_dl)s<span>Download</span></button>'
        '<ul class="menu" id="dl-menu" role="menu" hidden>%(downloads)s</ul></div>'
        '</div></div>'
        '<section class="share" id="share-panel" hidden aria-labelledby="share-h">'
        '<div class="share-head"><h2 id="share-h">Share</h2>'
        '<button type="button" class="icon-btn" id="share-close" aria-label="Close sharing">%(i_close)s</button></div>'
        '<div class="field"><label for="share-url">Link</label><div class="copyrow">'
        '<input id="share-url" type="text" readonly value="%(url)s" data-base="%(url)s">'
        '<button type="button" class="btn btn-primary" data-copy-from="share-url" data-copy-label="Link copied">'
        '<span class="btn-label">Copy link</span></button></div></div>'
        '<label class="check"><input type="checkbox" id="share-at"> <span>Start at <span id="share-time">0:00</span>'
        '</span></label>'
        '<div class="field"><label for="share-embed">Embed on a page</label>'
        '<textarea id="share-embed" readonly rows="3" spellcheck="false">%(embed)s</textarea>'
        '<div><button type="button" class="btn" data-copy-from="share-embed" data-copy-label="Embed code copied">'
        '<span class="btn-label">Copy embed code</span></button></div></div>'
        '<p class="status" id="copy-status" role="status" aria-live="polite"></p></section>'
        '<div class="desc" id="desc">'
        '<p class="desc-meta"><span class="views" data-views-for="%(key)s" data-views-full="1"></span>'
        '<span class="sep" aria-hidden="true">·</span><time datetime="%(date)s">%(fdate)s</time>'
        '<span class="sep" aria-hidden="true">·</span><span>%(fdw)s</span></p>'
        '<div class="desc-text" id="desc-text">%(desc)s</div>'
        '<button type="button" class="desc-toggle" id="desc-toggle" aria-expanded="false" aria-controls="desc-text" '
        'hidden>Show more</button></div>'
        '</div>'
        '<aside class="watch-side" aria-labelledby="next-h"><div class="side-head"><h2 id="next-h">Up next</h2>'
        '%(autoplay)s</div>%(side)s</aside>'
        '</div>'
    ) % {
        'next_attr': next_attr, 'player': player_html(v, theater=True), 'vis_note': vis_note,
        'title': E(v['title']), 'key': E(L.stats_key(v)),
        'i_share': icon('share'), 'i_dl': icon('download'), 'i_close': icon('close'), 'downloads': downloads,
        'url': E(vurl(v, True)), 'embed': E(embed_code(v)),
        'date': E(v['date']), 'fdate': fdate(v['date']), 'fdw': fdur_words(v['duration']),
        'icon_folder': icon('folder', 16), 'folder': folder_link, 'desc': desc_html,
        'autoplay': ('<label class="switch"><input type="checkbox" id="autoplay" role="switch">'
                     '<span class="switch-track" aria-hidden="true"></span><span>Autoplay</span></label>') if nxt else '',
        'side': side_list,
    }


def build_video(data, folders, v):
    f = folders[v['folder']]
    image, video = og_media(v)
    key = L.stats_key(v)
    body = watch_body(data, folders, v, f)
    d = L.video_dir(v)
    L.write_text(os.path.join(d, 'index.html'),
                 page('%s · JOYA Library' % v['title'], v.get('desc') or v['title'],
                      vurl(v, True), body, image=image, video=video, og_type='video.other', player=True,
                      cls='watch-page', attrs=' data-stat-key="%s" data-stat-src="page"' % E(key)))
    emb = '\n'.join([
        head('%s · JOYA Library' % v['title'], v.get('desc') or v['title'], vurl(v, True), image, video,
             'video.other', css_links(True)),
        '<body class="embed" data-stat-key="%s" data-stat-src="embed">' % E(key), '<main>', player_html(v, embed=True),
        '<h1 class="sr">%s</h1>' % E(v['title']), '</main>',
        '<script src="%s" defer></script>' % asset('player.js'),
        '<script src="%s" defer></script>' % asset('count.js'), '</body>', '</html>', ''])
    if L.is_unlisted(v):
        L.write_text(os.path.join(d, 'embed', 'index.html'), emb)
    else:
        L.write_text(os.path.join(L.SITE_ROOT, 'embed', v['slug'], 'index.html'), emb)


def build_404():
    body = ('<div class="wrap"><div class="empty empty-page">%s<h1>This page is not here</h1>'
            '<p>The link may be old, or the video may no longer be shared.</p>'
            '<p><a class="btn btn-primary" href="/">Go to the library</a></p></div></div>') % icon('search', 28)
    L.write_text(os.path.join(L.SITE_ROOT, '404.html'),
                 page('Not found · JOYA Library', 'This page is not here.', L.BASE_URL + '/404.html', body,
                      cls='notfound'))


def build_moved(data):
    """A redirect page where a public video used to be (it moved to another folder)."""
    live_paths = {L.page_path(v) for v in data['videos'] if L.is_public(v)}
    wanted = {}
    for m in data.get('moved', []):
        v = L.find(data, m['slug'])
        if v and L.is_public(v) and m['path'] not in live_paths and m['path'] != L.page_path(v):
            wanted[m['path']] = v
    for path, v in wanted.items():
        d = os.path.join(L.SITE_ROOT, path.strip('/'))
        if not L.inside_site(d):
            continue
        target = vurl(v)
        L.write_text(os.path.join(d, 'index.html'), (
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">'
            '<title>Moved · JOYA Library</title><link rel="canonical" href="%s">'
            '<meta http-equiv="refresh" content="0; url=%s"></head><body>'
            '<p>This video moved to <a href="%s">%s</a>.</p>'
            '<script>location.replace(%s + location.search + location.hash)</script></body></html>\n') % (
            E(vurl(v, True)), E(target), E(target), E(v['title']), json.dumps(target)))
        L.write_text(os.path.join(d, '.moved'), v['slug'] + '\n')
    # Remove redirect pages nobody needs any more (only ours: they carry a .moved marker).
    for f in os.listdir(L.SITE_ROOT):
        fd = os.path.join(L.SITE_ROOT, f)
        if not os.path.isdir(fd) or f in ('assets', 'embed', 'u'):
            continue
        for s in os.listdir(fd):
            sd = os.path.join(fd, s)
            if os.path.exists(os.path.join(sd, '.moved')) and '/%s/%s/' % (f, s) not in wanted:
                if sorted(os.listdir(sd)) == ['.moved', 'index.html']:
                    L.remove_tree(sd)


def build_all(data=None):
    os.umask(0o022)
    data = data or L.load()
    L.makedirs(L.SITE_ROOT)
    copy_assets()
    folders = {f['slug']: f for f in data['folders']}
    ready = [v for v in data['videos'] if not v.get('processing') and v.get('renditions')]
    for v in ready:
        if v['folder'] not in folders:
            folders[v['folder']] = {'slug': v['folder'], 'title': L.folder_title(v['folder']), 'order': 99}
            data['folders'].append(folders[v['folder']])
    view = dict(data, videos=ready)
    build_home(view, folders)
    for f in folders.values():
        build_folder(view, folders, f)
    n = 0
    for v in ready:
        if L.page_path(v):
            build_video(view, folders, v)
            n += 1
    build_404()
    build_moved(view)
    # Embeds of videos that are no longer public.
    emb_root = os.path.join(L.SITE_ROOT, 'embed')
    if os.path.isdir(emb_root):
        live = {v['slug'] for v in ready if L.is_public(v)}
        for name in os.listdir(emb_root):
            if name not in live and os.path.isdir(os.path.join(emb_root, name)):
                L.remove_tree(os.path.join(emb_root, name))
    print('built pages for %d video(s) (%d public) in %d folder(s) -> %s' % (
        n, sum(1 for v in ready if L.is_public(v)), len(folders), L.SITE_ROOT), file=sys.stderr)


if __name__ == '__main__':
    with L.locked():
        build_all()
