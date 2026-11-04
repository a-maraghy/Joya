"""Encoding pipeline of the JOYA Library, shared by add.py (the CLI) and server.py (the studio).

ingest(src, meta, progress) makes the renditions, poster and seek sprite for one video, writes
its manifest entry and rebuilds the pages. progress(text, fraction 0..1) is called as it goes.
"""
import datetime
import hashlib
import json
import math
import os
import subprocess
import tempfile

import joyalib as L

LADDER = [  # height, crf, maxrate, bufsize, audio bitrate
    (1080, 21, '6000k', '12000k', '160k'),
    (720, 22, '3500k', '7000k', '128k'),
    (480, 23, '1600k', '3200k', '128k'),
]


class PipelineError(Exception):
    pass


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise PipelineError('%s failed: %s' % (cmd[0], p.stderr.strip()[-600:]))
    return p.stdout


def probe(path):
    out = run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    info = json.loads(out)
    v = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'), None)
    if not v:
        raise PipelineError('the file has no video in it')
    a = next((s for s in info['streams'] if s.get('codec_type') == 'audio'), None)
    w, h = int(v['width']), int(v['height'])
    rot = 0
    for sd in v.get('side_data_list', []) or []:
        if 'rotation' in sd:
            rot = abs(int(sd['rotation'])) % 180
    if rot == 90:
        w, h = h, w
    dur = float(info['format'].get('duration') or v.get('duration') or 0)
    if dur <= 0:
        raise PipelineError('the video has no length')
    return {'width': w, 'height': h, 'duration': dur,
            'bytes': int(info['format'].get('size') or os.path.getsize(path)), 'has_audio': a is not None}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def even(x):
    return int(round(x / 2.0)) * 2


def ladder_for(src_h):
    top = min(1080, src_h)
    rungs = [r for r in LADDER if r[0] <= top]
    if not rungs or rungs[0][0] != top:
        # Source below 1080 but not on a rung (e.g. 900): its own height first, with the 1080 settings.
        rungs.insert(0, (even(top),) + LADDER[0][1:])
    seen, out = set(), []
    for r in rungs:
        if r[0] not in seen:
            seen.add(r[0])
            out.append(r)
    return out


def encode(src, dst, h, crf, maxrate, bufsize, abr, has_audio, duration, tick=None):
    tmp = dst + '.part.mp4'
    cmd = ['ffmpeg', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', src, '-map', '0:v:0']
    if has_audio:
        cmd += ['-map', '0:a:0']
    cmd += ['-vf', 'scale=-2:%d:flags=lanczos,format=yuv420p' % h,
            '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', str(crf),
            '-maxrate', maxrate, '-bufsize', bufsize,
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
            '-movflags', '+faststart', '-map_metadata', '-1']
    if has_audio:
        cmd += ['-c:a', 'aac', '-b:a', abr, '-ac', '2', '-ar', '48000']
    cmd.append(tmp)
    with tempfile.TemporaryFile() as err:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
        for line in p.stdout:
            if line.startswith('out_time_us=') and tick:
                try:
                    us = int(line.split('=', 1)[1])
                    tick(max(0.0, min(1.0, us / 1e6 / duration)))
                except ValueError:
                    pass
        rc = p.wait()
        if rc != 0:
            err.seek(0)
            if os.path.exists(tmp):
                os.remove(tmp)
            raise PipelineError('encoding %dp failed: %s' % (h, err.read().decode('utf-8', 'replace').strip()[-600:]))
    os.chmod(tmp, 0o644)
    L.chown(tmp)
    os.replace(tmp, dst)


def probe_image(path):
    out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
               '-of', 'csv=p=0', path])
    w, h = out.strip().split(',')[:2]
    return int(w), int(h)


def make_poster(src_img, video, at, out_dir):
    """Poster from an image file, or from the frame at `at` seconds of the video."""
    big = os.path.join(out_dir, 'poster.jpg')
    small = os.path.join(out_dir, 'poster-640.jpg')
    tmp_big, tmp_small = big + '.part.jpg', small + '.part.jpg'
    if src_img:
        inp = ['-i', src_img]
    else:
        inp = ['-ss', '%.3f' % max(0.0, at), '-i', video]
    run(['ffmpeg', '-v', 'error', '-y'] + inp + ['-frames:v', '1', '-vf', "scale='min(1280,iw)':-2:flags=lanczos",
                                                '-q:v', '3', tmp_big])
    run(['ffmpeg', '-v', 'error', '-y', '-i', tmp_big, '-vf', 'scale=640:-2:flags=lanczos', '-q:v', '4', tmp_small])
    for t, p in ((tmp_big, big), (tmp_small, small)):
        os.chmod(t, 0o644)
        L.chown(t)
        os.replace(t, p)
    pi = probe_image(big)
    return {'file': 'poster.jpg', 'small': 'poster-640.jpg', 'width': pi[0], 'height': pi[1]}


def vtt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return '%02d:%02d:%02d.%03d' % (h, m, s, ms)


def make_sprite(video, dur, w, h, out_dir):
    interval = max(2, int(math.ceil(dur / 100.0)))
    count = max(1, int(math.ceil(dur / interval)))
    tw = 160
    th = even(tw * h / float(w))
    cols = min(10, count)
    rows = int(math.ceil(count / float(cols)))
    jpg = os.path.join(out_dir, 'thumbs.jpg')
    run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-vf',
         'fps=1/%d:round=down,scale=%d:%d:flags=lanczos,tile=%dx%d' % (interval, tw, th, cols, rows),
         '-frames:v', '1', '-q:v', '5', jpg])
    os.chmod(jpg, 0o644)
    L.chown(jpg)
    lines = ['WEBVTT', '']
    for i in range(count):
        t0, t1 = i * interval, min((i + 1) * interval, dur)
        x, y = (i % cols) * tw, (i // cols) * th
        lines += ['%s --> %s' % (vtt_time(t0), vtt_time(t1)), 'thumbs.jpg#xywh=%d,%d,%d,%d' % (x, y, tw, th), '']
    L.write_text(os.path.join(out_dir, 'thumbs.vtt'), '\n'.join(lines))
    return {'file': 'thumbs.jpg', 'vtt': 'thumbs.vtt', 'interval': interval, 'width': tw, 'height': th}


def check_vtt(text):
    if not text.lstrip('﻿').lstrip().startswith('WEBVTT'):
        raise PipelineError('captions must be a WebVTT file (it starts with WEBVTT)')
    return text.lstrip('﻿')


def ensure_folder(data, folder, title=None):
    if not L.SLUG_RE.match(folder) or folder in L.RESERVED:
        raise PipelineError('folder must be a slug like pre-read (and not a reserved name)')
    f = next((f for f in data['folders'] if f['slug'] == folder), None)
    if not f:
        f = {'slug': folder, 'title': title or L.folder_title(folder), 'order': len(data['folders']), 'desc': ''}
        data['folders'].append(f)
    elif title:
        f['title'] = title
    return f


def ingest(src, meta, progress=None, force=False, new_only=False):
    """Encode `src` and publish it with `meta`:
    title, desc, folder, folder_title, date, slug, visibility, captions (path), captions_lang,
    captions_label, drop_captions, poster (path).
    new_only: never update an existing video; take a free slug instead (the studio's uploads)."""
    import build  # late: build imports nothing from here
    say = progress or (lambda text, frac: None)
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        raise PipelineError('no such file: %s' % src)
    folder = meta.get('folder') or 'pre-read'
    title = (meta.get('title') or '').strip()
    if not title:
        raise PipelineError('a title is required')
    if meta.get('date'):
        datetime.date.fromisoformat(meta['date'])
    vis = meta.get('visibility')
    if vis is not None and vis not in L.VISIBILITIES:
        raise PipelineError('visibility must be public, unlisted or private')

    say('Checking the file', 0.0)
    info = probe(src)
    digest = sha256(src)

    with L.locked():
        data = L.load()
        ensure_folder(data, folder, meta.get('folder_title'))
        base = meta.get('slug') or L.slugify(title)
        if not L.SLUG_RE.match(base) or base == 'embed':
            raise PipelineError('bad slug: %s' % base)
        old = L.find(data, base)
        if new_only and old:
            base = L.unique_slug(data, base)
            old = None
        if old and old.get('trashed'):
            raise PipelineError('%s is in the trash; restore it first or pass another slug' % base)
        if old and old['folder'] != folder and old.get('visibility', 'public') == 'public' and not meta.get('move'):
            raise PipelineError('slug %s is already used in folder %s; pass --slug' % (base, old['folder']))
        slug = base
        token = (old or {}).get('token') or L.new_token()
        visibility = vis or (old or {}).get('visibility') or 'public'
        # Reserve the slug for a new video so a parallel job cannot take it.
        if not old:
            data['videos'].append({'slug': slug, 'folder': folder, 'title': title, 'visibility': 'private',
                                   'token': token, 'processing': True, 'renditions': [], 'added': L.now_iso(),
                                   'updated': L.now_iso(), 'date': meta.get('date') or datetime.date.today().isoformat(),
                                   'desc': meta.get('desc') or '', 'duration': info['duration'],
                                   'width': info['width'], 'height': info['height']})
            L.save(data)
        work_entry = dict(old) if old else {'slug': slug, 'folder': folder, 'token': token, 'visibility': 'private'}

    # Encode where the files live now (an update) or in the store (a new video, moved when done).
    out_dir = L.video_dir(work_entry)
    L.makedirs(out_dir)
    same_source = bool(old and old.get('source', {}).get('sha256') == digest)
    rungs = ladder_for(info['height'])
    weights = [r[0] * r[0] for r in rungs]
    total = float(sum(weights)) * 1.06
    done = 0.0
    renditions = []
    try:
        for (h, crf, mr, bs, ab), wgt in zip(rungs, weights):
            dst = os.path.join(out_dir, '%dp.mp4' % h)
            if not (same_source and not force and os.path.exists(dst)):
                label = 'Encoding %dp' % h
                say(label, done / total)
                encode(src, dst, h, crf, mr, bs, ab, info['has_audio'], info['duration'],
                       tick=lambda f, base=done, w=wgt, lab=label: say(lab, (base + f * w) / total))
            done += wgt
            ri = probe(dst)
            renditions.append({'height': ri['height'], 'width': ri['width'], 'file': '%dp.mp4' % h,
                               'bytes': os.path.getsize(dst), 'bitrate': int(ri['bytes'] * 8 / ri['duration'])})
        keep = {r['file'] for r in renditions}
        for name in os.listdir(out_dir):
            if name.endswith('p.mp4') and name not in keep:
                os.remove(os.path.join(out_dir, name))

        say('Making the poster and previews', done / total)
        top = os.path.join(out_dir, renditions[0]['file'])
        duration = probe(top)['duration']
        poster_src = os.path.abspath(meta['poster']) if meta.get('poster') else None
        if poster_src or not old or not old.get('poster') or not same_source:
            poster = make_poster(poster_src, top, duration * 0.1, out_dir)
        else:
            poster = old['poster']
        sprite = make_sprite(top, duration, renditions[0]['width'], renditions[0]['height'], out_dir)

        captions = []
        if meta.get('captions'):
            with open(meta['captions'], encoding='utf-8-sig') as f:
                text = check_vtt(f.read())
            lang = meta.get('captions_lang') or 'en'
            name = 'captions.%s.vtt' % lang
            L.write_text(os.path.join(out_dir, name), text)
            captions.append({'file': name, 'lang': lang, 'label': meta.get('captions_label') or 'English'})
        elif old and not meta.get('drop_captions'):
            captions = [c for c in old.get('captions', []) if os.path.exists(os.path.join(out_dir, c['file']))]
    except Exception:
        if not old:  # give the slug back
            with L.locked():
                data = L.load()
                data['videos'] = [v for v in data['videos'] if not (v['slug'] == slug and v.get('processing'))]
                L.save(data)
        raise

    say('Publishing', 0.98)
    with L.locked():
        data = L.load()
        cur = L.find(data, slug) or {}
        entry = {
            'slug': slug, 'folder': folder, 'title': title, 'desc': meta.get('desc') or '',
            'date': meta.get('date') or cur.get('date') or datetime.date.today().isoformat(),
            'added': cur.get('added') or L.now_iso(), 'updated': L.now_iso(),
            'duration': round(duration, 3), 'width': renditions[0]['width'], 'height': renditions[0]['height'],
            'renditions': renditions, 'poster': poster, 'sprite': sprite, 'captions': captions,
            'source': {'name': meta.get('source_name') or os.path.basename(src), 'bytes': info['bytes'],
                       'sha256': digest},
            'visibility': visibility, 'token': token,
        }
        L.relocate(out_dir, entry)
        if old and old['folder'] != folder and L.is_public(old):
            note_moved(data, old)
        data['videos'] = [v for v in data['videos'] if v['slug'] != slug] + [entry]
        L.save(data)
        build.build_all(data)
    say('Done', 1.0)
    return entry


def note_moved(data, old):
    """Remember a public URL that moved, so build.py can leave a redirect page there."""
    path = '/%s/%s/' % (old['folder'], old['slug'])
    data.setdefault('moved', [])
    data['moved'] = [m for m in data['moved'] if m['path'] != path] + [{'path': path, 'slug': old['slug']}]
