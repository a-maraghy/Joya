"""Changes to videos already in the JOYA Library, shared by add.py and the studio service.
Every function takes the manifest lock, saves, rebuilds the pages and returns the entry.
Nothing here deletes a video: "delete" moves it to the trash, which the studio can restore."""
import datetime
import os
import shutil

import joyalib as L
import pipeline as P


class OpError(Exception):
    pass


def _get(data, slug):
    v = L.find(data, slug)
    if not v or v.get('processing'):
        raise OpError('no video with slug %s' % slug)
    return v


def _commit(data):
    import build
    L.save(data)
    build.build_all(data)


def update(slug, title=None, desc=None, date=None, folder=None, visibility=None):
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        if v.get('trashed'):
            raise OpError('restore the video from the trash first')
        before = dict(v)
        old_dir = L.video_dir(v)
        if title is not None:
            title = title.strip()
            if not title:
                raise OpError('the title cannot be empty')
            if len(title) > 200:
                raise OpError('the title is longer than 200 characters')
            v['title'] = title
        if desc is not None:
            if len(desc) > 5000:
                raise OpError('the description is longer than 5000 characters')
            v['desc'] = desc.strip()
        if date is not None:
            try:
                datetime.date.fromisoformat(date)
            except ValueError:
                raise OpError('the date must look like 2026-10-27')
            v['date'] = date
        if folder is not None and folder != v['folder']:
            if not any(f['slug'] == folder for f in data['folders']):
                raise OpError('no folder %s' % folder)
            v['folder'] = folder
        if visibility is not None:
            if visibility not in L.VISIBILITIES:
                raise OpError('visibility must be public, unlisted or private')
            v['visibility'] = visibility
        if L.is_public(before) and L.page_path(before) != L.page_path(v):
            P.note_moved(data, before)
        L.relocate(old_dir, v)
        v['updated'] = L.now_iso()
        _commit(data)
        return v


def create_folder(title, desc=''):
    title = (title or '').strip()
    if not title:
        raise OpError('a folder needs a name')
    if len(title) > 80:
        raise OpError('the folder name is longer than 80 characters')
    with L.locked():
        data = L.load()
        if any(f['title'].lower() == title.lower() for f in data['folders']):
            raise OpError('there is already a folder called %s' % title)
        base = L.slugify(title)
        slug, i = base, 2
        taken = {f['slug'] for f in data['folders']} | L.RESERVED
        while slug in taken:
            slug = '%s-%d' % (base, i)
            i += 1
        f = {'slug': slug, 'title': title, 'order': len(data['folders']), 'desc': (desc or '').strip()}
        data['folders'].append(f)
        _commit(data)
        return f


def trash(slug):
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        if v.get('trashed'):
            return v
        old_dir = L.video_dir(v)
        v['trashed'] = {'at': L.now_iso(), 'visibility': v.get('visibility', 'public')}
        L.relocate(old_dir, v)
        _commit(data)
        return v


def restore(slug):
    """Back from the trash as Private: it is visible again in the studio, and the owner chooses
    when it goes back out."""
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        if not v.get('trashed'):
            return v
        old_dir = L.video_dir(v)
        v.pop('trashed', None)
        v['visibility'] = 'private'
        L.relocate(old_dir, v)
        v['updated'] = L.now_iso()
        _commit(data)
        return v


def set_poster(slug, at=None, image=None):
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        d = L.video_dir(v)
        top = os.path.join(d, sorted(v['renditions'], key=lambda r: -r['height'])[0]['file'])
        if image is None:
            at = max(0.0, min(float(at or 0), v['duration'] - 0.05))
        try:
            v['poster'] = P.make_poster(image, top, at or 0, d)
        except P.PipelineError as e:
            raise OpError('that image could not be read' if image else str(e))
        v['updated'] = L.now_iso()
        _commit(data)
        return v


def set_captions(slug, text, lang='en', label='English'):
    lang = (lang or 'en').strip().lower()
    if not L.SLUG_RE.match(lang) or len(lang) > 12:
        raise OpError('the language must be a code like en or ar')
    label = (label or lang).strip()[:40]
    try:
        text = P.check_vtt(text)
    except P.PipelineError as e:
        raise OpError(str(e))
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        name = 'captions.%s.vtt' % lang
        L.write_text(os.path.join(L.video_dir(v), name), text)
        v['captions'] = [c for c in v.get('captions', []) if c['lang'] != lang] + [
            {'file': name, 'lang': lang, 'label': label}]
        v['updated'] = L.now_iso()
        _commit(data)
        return v


def remove_captions(slug, lang):
    """Captions come off the video; the file is kept beside it as captions.<lang>.vtt.removed."""
    with L.locked():
        data = L.load()
        v = _get(data, slug)
        d = L.video_dir(v)
        for c in v.get('captions', []):
            if c['lang'] == lang:
                p = os.path.join(d, c['file'])
                if os.path.exists(p):
                    shutil.move(p, p + '.removed')
        v['captions'] = [c for c in v.get('captions', []) if c['lang'] != lang]
        v['updated'] = L.now_iso()
        _commit(data)
        return v
