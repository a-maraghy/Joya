#!/usr/bin/env python3
"""Add a video to the JOYA Library (or change one), then rebuild every page.

  python3 library/add.py --folder pre-read --title "Title" --desc "One paragraph." \
      [--visibility public|unlisted|private] [--date YYYY-MM-DD] [--captions file.vtt] [--poster img] \
      [--slug my-slug] [--force] video.mp4
  python3 library/add.py --visibility unlisted --slug <slug>     change who can see a video
  python3 library/add.py --remove <slug>                         move a video to the trash
  python3 library/add.py --restore <slug>                        bring it back (as Private)
  python3 library/add.py --list                                  every video with its link

What it makes for each video (in its folder, its unlisted folder or the private store):
  1080p.mp4 720p.mp4 480p.mp4  H.264 high + AAC, +faststart, 2 s keyframes (never upscaled;
                               the top one is the source height when that is below 1080)
  poster.jpg poster-640.jpg    from --poster, else a frame at 10 %
  thumbs.jpg thumbs.vtt        seek-preview sprite (<= 100 tiles) and its WebVTT map
  captions.en.vtt              when --captions is given
A repeat run with the same title (slug) updates that entry and keeps its visibility and its
unlisted link; the renditions are only re-encoded when the source file changed or --force is given.
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joyalib as L  # noqa: E402
import ops  # noqa: E402
import pipeline as P  # noqa: E402


def show(v):
    vis = 'trash' if v.get('trashed') else v.get('visibility', 'public')
    path = L.page_path(v)
    return '%-9s %-32s %s' % (vis, v['slug'], (L.BASE_URL + path) if path else '(studio only)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video', nargs='?')
    ap.add_argument('--folder', default=None, help='folder slug (default pre-read); created when new')
    ap.add_argument('--folder-title')
    ap.add_argument('--title')
    ap.add_argument('--desc', default=None)
    ap.add_argument('--visibility', choices=L.VISIBILITIES,
                    help='public (listed), unlisted (only by its link) or private (studio only). '
                         'Default: public for a new video, unchanged for an update.')
    ap.add_argument('--date', help='YYYY-MM-DD, the date shown and sorted on (default: today)')
    ap.add_argument('--captions', help='a WebVTT file')
    ap.add_argument('--captions-lang', default='en')
    ap.add_argument('--captions-label', default='English')
    ap.add_argument('--drop-captions', action='store_true', help='on a repeat run, remove existing captions')
    ap.add_argument('--poster')
    ap.add_argument('--slug')
    ap.add_argument('--force', action='store_true', help='re-encode even when the source is unchanged')
    ap.add_argument('--remove', metavar='SLUG', help='move a video to the trash (restorable)')
    ap.add_argument('--restore', metavar='SLUG', help='bring a video back from the trash, as Private')
    ap.add_argument('--list', action='store_true')
    args = ap.parse_args()
    os.umask(0o022)
    try:
        if args.list:
            for v in sorted(L.load()['videos'], key=lambda v: v.get('date', ''), reverse=True):
                print(show(v))
            return
        if args.remove:
            v = ops.trash(args.remove)
            print('moved to the trash: %s (restore with --restore %s)' % (v['slug'], v['slug']))
            return
        if args.restore:
            v = ops.restore(args.restore)
            print('restored as private: %s' % v['slug'])
            return
        if not args.video:
            if args.slug and (args.visibility or args.title or args.desc is not None or args.date or args.folder):
                v = ops.update(args.slug, title=args.title, desc=args.desc, date=args.date, folder=args.folder,
                               visibility=args.visibility)
                print(show(v))
                return
            ap.error('a video and --title are required (or --slug with --visibility/--title/--desc/--date/--folder)')
        if not args.title:
            ap.error('--title is required')
        if shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None:
            raise SystemExit('ffmpeg and ffprobe are needed')
        meta = {'title': args.title, 'desc': args.desc or '', 'folder': args.folder or 'pre-read',
                'folder_title': args.folder_title, 'date': args.date, 'slug': args.slug,
                'visibility': args.visibility, 'captions': args.captions, 'captions_lang': args.captions_lang,
                'captions_label': args.captions_label, 'drop_captions': args.drop_captions, 'poster': args.poster}
        last = [None]

        def progress(text, frac):
            if text != last[0]:
                last[0] = text
                print('  %s ...' % text, flush=True)
        v = P.ingest(args.video, meta, progress, force=args.force)
        print('done: %s' % show(v))
        for r in v['renditions']:
            print('  %4dp  %dx%d  %.1f MB  %.2f Mbit/s' % (r['height'], r['width'], r['height'], r['bytes'] / 1e6,
                                                         r['bitrate'] / 1e6))
    except (ops.OpError, P.PipelineError) as e:
        raise SystemExit(str(e))


if __name__ == '__main__':
    main()
