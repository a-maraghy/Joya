# JOYA Library

Our own video site at **https://library.example.com**: folders of shared videos with a
YouTube-like home page, watch page and studio, but nothing from YouTube. **Watching needs no
account.** Signing in (the **studio**, `/studio/`) is only for uploading and managing videos.
Every page is `noindex`, the site makes no third-party requests (no CDN, no outside fonts, no
analytics), and it uses the JOYA "Plain label" look: black and white, Atkinson Hyperlegible
Next and Mono, light or dark from the system, the word JOYA as the logo.

## How it fits together

| Part | What it is |
|---|---|
| Static pages | `build.py` writes every public page into `/var/www/library`. nginx serves them, so watching keeps working even when the service is down (only the counts disappear). |
| Service | `server.py`, systemd unit **`joya-library`**, Python standard library only, on **127.0.0.1:8795** behind nginx. It answers `/api/*` (view counts, the studio API) and `/studio/*` (studio pages). |
| Manifest | `/var/lib/joya-library/library.json` (+ `.bak`): folders and videos. The CLI and the studio both write it, one at a time (`library.json.lock`). |
| Database | `/var/lib/joya-library/library.db` (SQLite, 0600): studio users, sessions, plays and views, uploads, jobs, an audit log. |
| Secret | `/var/lib/joya-library/secret.key` (0600, made on first start): the HMAC key for device and IP hashes. Never print it. |
| Private store | `/var/lib/joya-library/store/<slug>/`: private and trashed videos. nginx serves them only to the studio (`/_store/` is `internal`). |
| Uploads, originals | `/var/lib/joya-library/uploads/` (partial uploads, 0700) and `/var/lib/joya-library/sources/<slug>/` (the uploaded original, kept for re-encoding). |
| Code the service runs | `/opt/joya-library/library` (a copy made by `deploy/install.sh`; the `joyalib` user cannot read `/root`). |

Files belong to the system user **`joyalib`** (the service runs as it). The CLI tools run as root
and hand what they write back to `joyalib`. Video files, the database and secrets never go into the repo.

## Visibility (like YouTube)

| | Where | Listed | Who can watch |
|---|---|---|---|
| **Public** | `/<folder>/<slug>/`, embed `/embed/<slug>/` | home page, its folder, search, Up next | anyone |
| **Unlisted** | `/u/<24-hex token>/<slug>/`, embed `/u/<token>/<slug>/embed/` | nowhere: not on any page, in search, in Up next, in `/api/stats` | anyone with the link |
| **Private** | the store | nowhere | the studio only; public links 404 |

- An unlisted video keeps **one token for life**: edits, new uploads and switching back and forth
  between Public, Unlisted and Private never change its link. `/u/` and `/u/<token>/` are 404.
- Switching to Public moves the files into the folder and rebuilds the pages; switching away
  removes it from every listing at once.
- **Delete is "Move to the trash"**: the files move to the store and the video leaves the site.
  The studio's Trash lists it, and **Restore** brings it back as Private. Nothing is deleted for good.
- Moving a public video to another folder leaves a small redirect page at its old address.

## View counts

- **A view** is counted once a play has really played **30 seconds, or half of a shorter video**,
  whichever comes first. Only time that passed while playing counts: seeking ahead does not.
- **One view per device per video in 30 minutes**: replays and reloads in that window do not add views.
- **Unique viewers** are distinct devices. A device is a random id the browser keeps in localStorage
  and a first-party cookie (`mlid`). When storage is blocked, the fallback is a keyed hash
  (HMAC with the secret) of the IP address and browser. **Raw IP addresses are never stored**: the
  database holds only keyed hashes; per-address rate limits live in memory.
- **Embeds count too**, and are told apart in the studio ("Embedded on <site>").
- **Bots** (crawler, preview, headless and script user agents) are ignored, and an address may report
  at most 120 times a minute, start 60 plays in 10 minutes and add 40 views an hour.
- The server also bounds what a play can claim by the real time since it started (up to 2× speed).
- `count.js` sends the reports (`POST /api/beat`): when playback starts, when it crosses the
  threshold, every 15 s while playing, on pause, at the end and when the page is left.
- Public pages ask `GET /api/stats?ids=…` for their counts; if the service is down the pages still
  render, just without counts. Unlisted pages ask with `u:<token>`.

## The public site

- **Home** (`/`): every public video, newest first, with folder chips, **Sort** (Newest first,
  Most viewed, Oldest first, Title A–Z, Longest; kept in `?sort=` and localStorage) and **search** in
  the top bar (title, description and folder words; `?q=`). Cards show poster, length, title,
  folder, views and a relative date ("3 days ago"), plus a watched-progress bar.
  **Continue watching** lists videos you left part way (from this browser's localStorage).
- **Folder pages** (`/<folder>/`): the same grid for one folder.
- **Watch page**: the player; title; folder; **Share** (copy link, link at the current time `?t=`,
  embed code); **Download** (one link per quality); the description box with "N views · M unique
  viewers", date and length, three lines with Show more; **Up next** with an **Autoplay** switch
  (on by default, off under reduced motion; an 8-second countdown with Cancel at the end);
  **theater mode** (button or `T`, remembered).
- **Keyboard**: Space/K play, J/L ±10 s, ←/→ ±5 s, ↑/↓ volume, M mute, F full screen, T theater,
  C captions, I picture in picture, </> speed, 0–9 jump, Shift+N next video, ? shortcuts, / search.
- `404.html` for anything that is not there.

## The player (`player/player.js`, `player/player.css`)

Vanilla JS, no dependencies, shared by the watch page, the embed and the studio preview. Quality
Auto/1080/720/480 with seamless switching, seek previews from a sprite, captions drawn by the
player, speed, picture in picture, full screen, resume where you left off, `?t=` start times,
keyboard shortcuts with a `?` overlay, a live region for announcements, reduced-motion support.
New in v2: a theater button (when the page offers it), `T` and `Shift+N`, and the Up next end screen
(`setNext(next, autoplay)`, `setAutoNext`), and `?autoplay=1` when arriving from Up next.

## The studio (`/studio/`)

- **Sign in** at `/studio/login`. Sessions last 14 days (sliding), in an HttpOnly, Secure,
  SameSite=Strict cookie. Ten failed attempts per address or per user name in 15 minutes lock
  sign-in for that address or name, and nginx limits `/api/studio/login` to 20 requests a minute.
- **Every write** needs a session **and** a same-origin request (the `Origin` header, else
  `Sec-Fetch-Site`, else the `Referer`, must be the site itself); otherwise 403.
- **Your videos**: a table of every video with visibility (● Public, ◐ Unlisted, ○ Private,
  ▲ In the trash), folder, date, views and unique viewers; filters All / Public / Unlisted /
  Private / Trash; search.
- **Upload**: drag files anywhere on the page or use Upload video. Files go up in 8 MB chunks with
  a progress bar and time left; Pause/Resume; a dropped connection retries; **picking the same file
  again resumes** where it stopped. Fill in title, description, folder (or **New folder…**), date
  and visibility (Private by default) while it uploads and press **Save details**. Encoding starts
  when both are done and runs in the background with its progress shown (the same pipeline as the
  CLI). A failed job can be retried.
- **Edit a video** (`/studio/v/<slug>`): title, description, folder, date, visibility; a preview
  player; the link and embed code; **poster** from the frame you paused on or from an uploaded
  image; **captions** (.vtt) per language, added or removed (a removed file is kept as
  `captions.<lang>.vtt.removed`); **Move to the trash** / **Restore**.
- **Analytics** per video: views, unique viewers, watch time, plays started, average view duration
  and the share of the video it is, views per day for the last 28 days (UTC; a bar chart with a
  table view and keyboard reading), and where views came from (library pages, direct, links from
  another site, embedded on a site).

## Commands

```sh
# Accounts for the studio (prompts for the password; at least 12 characters).
python3 /opt/joya-library/library/admin.py user add <name>
python3 /opt/joya-library/library/admin.py user passwd <name>     # also signs that user out
python3 /opt/joya-library/library/admin.py user disable|enable <name>
python3 /opt/joya-library/library/admin.py user list
python3 /opt/joya-library/library/admin.py sessions clear

# Add or update a video from the command line (still works; same pipeline as the studio).
python3 library/add.py --folder pre-read --title "Title" --desc "One paragraph." \
    [--visibility public|unlisted|private] [--date YYYY-MM-DD] [--captions captions.vtt] \
    [--poster poster.jpg] [--slug custom-slug] [--force] video.mp4
python3 library/add.py --slug <slug> --visibility public      # change visibility (or --title/--desc/--date/--folder)
python3 library/add.py --remove <slug>                         # move to the trash
python3 library/add.py --restore <slug>                        # back from the trash, as Private
python3 library/add.py --list                                  # every video with its link

# Rebuild every page from the manifest.
python3 library/build.py

# Install or update the service and the pages after a code change.
bash library/deploy/install.sh

# Captions from a film timeline (the agents-film timeline.json + words.js format).
python3 library/tools/timeline_to_vtt.py timeline.json words.js > captions.en.vtt
```

- **Slug.** From the title. A CLI run with the same title updates that video and keeps its
  visibility and its unlisted link. The studio never overwrites: a second upload with the same
  title gets `-2`.
- **Re-encoding.** Only when the source's sha256 changes or with `--force`.
- **New folders.** `--folder <slug>` (with `--folder-title`) or **New folder…** in the studio.
  Folder names that are routes (`u`, `embed`, `assets`, `studio`, `api`, …) are refused.

## What the pipeline makes for each video

`1080p.mp4`, `720p.mp4`, `480p.mp4` (H.264 High + AAC, `+faststart`, a keyframe every 2 s on the same
grid in every rendition, never upscaled; CRF / maxrate 21 / 6, 22 / 3.5 and 23 / 1.6 Mbit/s),
`poster.jpg` (≤ 1280 wide, og:image) and `poster-640.jpg` (cards), `thumbs.jpg` + `thumbs.vtt` (seek
previews, ≤ 100 tiles), and `captions.<lang>.vtt`. Files are 0644 and folders 0755 (nginx reads them).

## nginx

The `library.example.com` server block holds TLS, `root /var/www/library`, `error_page 404`,
the internal `/_store/` alias and `include snippets/joya-library-locations.conf`
(`deploy/nginx-library-locations.conf`: `/api/` and `/studio/` to the service, `/api/studio/login`
rate-limited, media and assets caching, dot-files and bare folders 404). `deploy/nginx-http.conf`
becomes `/etc/nginx/conf.d/joya-library.conf` (the upstream and the login rate zone).
`install.sh` installs both and reloads nginx only after `nginx -t` passes.

## Tests

```sh
bash library/tests/scratch.sh up   /tmp/joyalib-scratch   # its own nginx :18790 + service :18795
bash library/tests/scratch.sh seed /tmp/joyalib-scratch   # 4 test videos + a throwaway user "tester"
NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
  node library/tests/e2e.cjs /tmp/joyalib-scratch [/tmp/shots]
bash library/tests/scratch.sh down /tmp/joyalib-scratch
```

The scratch instance never touches production. The suite covers listings and search (unlisted and
private never appear), the 404s, view counting (threshold, 30-minute dedup, unique viewers, seeks,
bots, embeds), the watch page (theater, keys, share, Continue watching, Most viewed), the studio
(sign-in, cookie flags, 401 without a session, 403 for another or missing Origin, resumable chunked
upload, upload → encode → publish, visibility and the stable unlisted link, poster, captions,
trash and restore, analytics, sign-out), and with a shots folder every page at 1920, 1366 and
390 px in light and dark with no sideways scrolling and no console errors.

## Content so far

| Folder | Slug | Title | Date |
|---|---|---|---|
| pre-read | `allocate-meets-matrix` | AlloCate meets Matrix | 2026-10-27 |

The source was `/root/joya/docs/allocate_film/AlloCate_meets_Matrix_EN.mp4`, the final render of
2026-10-27 06:37. Its captions were made from the film's own `player/timeline.json` + `words.js`.
The film also has its captions burned in, which is why CC starts off. The old share link
`joya.example.com/share/bf202a41…/` redirects to its watch page.
