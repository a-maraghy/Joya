"""Send a file the agent made back into the chat that asked for it.

Claude gets one tool, ``send_file(path, caption)``, from an in-process MCP
server that is built afresh for every request and bound to the Telegram
message being answered. The tool has no chat or topic argument: the target is
the message itself, and the file is posted with ``message.reply_document``,
which is the same call path PTB uses for the text reply -- same chat, same
forum topic (none for General), nothing else reachable. A second request
running at the same time in another topic has its own server, bound to its
own message, so the two can never cross.

What the tool will post:

* a regular file that resolves (realpath) inside the agent's approved
  directory; a symbolic link as the named file is refused outright, and a
  link anywhere on the way that leads outside is refused by the realpath
  check. The file is opened with O_NOFOLLOW and the opened descriptor is
  checked again, so swapping a path component after the check gains nothing;
* with one of :data:`ALLOWED_EXTENSIONS`; an ``.svg`` must also pass
  :func:`.drawing.check_svg` (no scripts, no references out of the file);
* not empty and no bigger than ``FILE_SEND_MAX_MB`` (Telegram's own limit
  for bots is 50 MB);
* at most ``FILE_SEND_MAX_PER_REPLY`` files while answering one message.

With drawing on (``ALLOW_DRAWING``), the same server also offers
``render_svg`` and ``contact_sheet`` (see :mod:`.drawing`): they render the
agent's own SVG to PNG inside its folder and return the picture to Claude as
an image content block, so it can look at what it drew and improve it before
anything is sent; ``send_file(..., preview=true)`` adds a PNG preview photo
next to the vector file.

Why our own small MCP server object rather than ``create_sdk_mcp_server``:
the SDK's helper registers handlers through ``mcp.server.Server`` decorators
that mcp 2.x removed, so it raises ``AttributeError`` in the runtime venv.
The SDK routes ``tools/list`` and ``tools/call`` by looking up
``server.request_handlers[ListToolsRequest | CallToolRequest]`` and reading
``result.root``; :class:`_ToolServer` provides exactly that and nothing else.
``tests/unit/test_claude/test_file_send.py`` runs the SDK's own router
against it, so an SDK change that breaks the contract fails a test.
"""

from __future__ import annotations

import os
import re
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

import structlog

from .drawing import (
    RASTER_EXTENSIONS,
    DrawingError,
    DrawPolicy,
    check_svg,
    contact_sheet_svg,
    drawing_guide,
    fit,
    on_checker_svg,
    parse_background,
    png_size,
    raster_kind,
    render_jobs,
    small_strip_svg,
    write_output,
)

logger = structlog.get_logger()

SERVER_NAME = "joya_files"
TOOL_NAME = "send_file"
RENDER_TOOL_NAME = "render_svg"
SHEET_TOOL_NAME = "contact_sheet"
QUALIFIED_TOOL_NAME = f"mcp__{SERVER_NAME}__{TOOL_NAME}"
DRAWING_TOOL_NAMES = (RENDER_TOOL_NAME, SHEET_TOOL_NAME)


def qualified(name: str) -> str:
    return f"mcp__{SERVER_NAME}__{name}"


ALLOWED_EXTENSIONS: FrozenSet[str] = frozenset(
    {".docx", ".pdf", ".xlsx", ".csv", ".txt", ".md", ".svg"} | RASTER_EXTENSIONS
)
# Telegram's limits for a photo (sendPhoto): 10 MB, and width + height <= 10000.
PHOTO_MAX_BYTES = 10 * 1024 * 1024

# Telegram's caption limit for media, in characters.
CAPTION_LIMIT = 1024

TOOL_DESCRIPTION = (
    "Send a file you made (Word .docx, PDF, Excel .xlsx, .csv/.txt/.md, an "
    "SVG drawing, or a .png/.jpg/.webp picture) to the person you are "
    "answering, as a document in this same chat and topic. The file must "
    "already exist inside your working folder. Give a short caption saying "
    "what it is. Use it once per file; you cannot choose another chat."
)
DRAW_SEND_NOTE = (
    " For an .svg, preview=true also sends a PNG preview photo of it "
    "(rendered on `background`, default white); as_photo=true posts a "
    ".png/.jpg/.webp as a photo shown inline instead of as a file."
)

_PATH_PROP = {
    "type": "string",
    "description": (
        "Path of the file, relative to your working folder or absolute "
        "inside it, e.g. reports/sales-2026-10.pdf"
    ),
}
_BG_PROP = {
    "type": "string",
    "description": "transparent (default for renders), light, dark, or a #hex colour",
}

TOOL_INPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": _PATH_PROP,
        "caption": {
            "type": "string",
            "description": "Short caption shown under the file (max 1024 characters)",
        },
    },
    "required": ["path"],
    "additionalProperties": False,
}


def _send_schema(drawing: bool) -> Dict[str, Any]:
    if not drawing:
        return TOOL_INPUT_SCHEMA
    props = dict(TOOL_INPUT_SCHEMA["properties"])
    props["preview"] = {
        "type": "boolean",
        "description": "For an .svg: also send a PNG preview photo of it",
    }
    props["as_photo"] = {
        "type": "boolean",
        "description": "For a .png/.jpg/.webp: post it as a photo (shown inline)",
    }
    props["background"] = dict(
        _BG_PROP,
        description="Background of the PNG preview: light (default), dark, #hex",
    )
    return dict(TOOL_INPUT_SCHEMA, properties=props)


RENDER_DESCRIPTION = (
    "Render an SVG drawing in your folder to PNG and LOOK at it: returns the "
    "picture to you (plus a strip showing it at 32 px and 64 px on light and "
    "dark) and saves the PNG next to the SVG (same name, .png). Nothing is "
    "sent to the chat. Use it after every draft to critique and refine."
)
RENDER_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": dict(
            _PATH_PROP,
            description="The .svg file, e.g. drawings/mavix-geometric-v1.svg",
        ),
        "size": {
            "type": "integer",
            "description": "Longest edge of the saved PNG in px (default 1024)",
        },
        "background": _BG_PROP,
        "small_sizes": {
            "type": "boolean",
            "description": "Also show the 32/64 px strip (default true)",
        },
    },
    "required": ["path"],
    "additionalProperties": False,
}
SHEET_DESCRIPTION = (
    "Lay several drawings (.svg or .png in your folder) side by side on one "
    "contact-sheet PNG with a label under each, save it, and show it to you. "
    "Send it with send_file(..., as_photo=true) when offering variants."
)
SHEET_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "2-12 files",
        },
        "labels": {
            "type": "array",
            "items": {"type": "string"},
            "description": "One short label per file (default: the file names)",
        },
        "columns": {
            "type": "integer",
            "description": "Default: 2 for up to 4, else 3-4",
        },
        "tile": {"type": "integer", "description": "Tile size in px (default 480)"},
        "background": dict(
            _BG_PROP, description="light (default), dark, transparent, #hex"
        ),
        "out": {
            "type": "string",
            "description": "Where to save the .png (default drawings/sheet-<time>.png)",
        },
    },
    "required": ["paths"],
    "additionalProperties": False,
}


class FileSendError(Exception):
    """A file that cannot be sent; the message is shown to the model."""


SLUG_RE = re.compile(r"[^a-z0-9]+")


def confined_output(raw_path: str, root: Path, cwd: Path, ext: str) -> Path:
    """Where a PNG may be written: inside the agent's folder, never via a link."""
    if not isinstance(raw_path, str) or not raw_path.strip() or "\x00" in raw_path:
        raise FileSendError("No output path given.")
    named = Path(raw_path.strip()).expanduser()
    if not named.is_absolute():
        named = Path(cwd) / named
    lexical = os.path.normpath(str(named))
    root_real = os.path.realpath(root)
    if Path(lexical).suffix.lower() != ext:
        raise FileSendError(f"The output must be a {ext} file.")
    if not (
        _within(lexical, root_real) or _within(lexical, os.path.normpath(str(root)))
    ):
        raise FileSendError("The output must be inside your folder.")
    parent = os.path.dirname(lexical)
    os.makedirs(parent, exist_ok=True)
    if not _within(os.path.realpath(parent), root_real):
        raise FileSendError("The output folder leads outside your folder.")
    if os.path.islink(lexical):
        raise FileSendError("The output path is a symbolic link; pick another name.")
    return Path(os.path.realpath(parent)) / os.path.basename(lexical)


@dataclass(frozen=True)
class FileSendPolicy:
    """Where files may come from, which ones, how big and how many."""

    root: Path
    max_bytes: int = 20 * 1024 * 1024
    max_files: int = 5
    extensions: FrozenSet[str] = ALLOWED_EXTENSIONS

    @classmethod
    def from_settings(cls, settings: Any) -> "FileSendPolicy":
        return cls(
            root=Path(settings.approved_directory),
            max_bytes=int(settings.file_send_max_bytes),
            max_files=int(settings.file_send_max_per_reply),
        )


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def open_confined(raw_path: str, policy: FileSendPolicy, cwd: Path) -> tuple:
    """Open *raw_path* for sending, or raise :class:`FileSendError`.

    Returns ``(file_object, real_path, size)``. The caller closes the file.
    """
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise FileSendError("No path given.")
    if "\x00" in raw_path:
        raise FileSendError("Invalid path.")

    named = Path(raw_path.strip()).expanduser()
    if not named.is_absolute():
        named = Path(cwd) / named

    root_real = os.path.realpath(policy.root)
    # Where the name points lexically (.. collapsed, links not followed) and
    # where it really leads. Both have to stay inside the agent's folder.
    lexical = os.path.normpath(str(named))
    real = os.path.realpath(lexical)
    if not _within(lexical, root_real) and not _within(
        lexical, os.path.normpath(str(policy.root))
    ):
        raise FileSendError(
            "That file is outside your folder; only files in it can be sent."
        )
    if not _within(real, root_real):
        raise FileSendError("That path leads outside your folder; it cannot be sent.")
    if os.path.islink(lexical):
        raise FileSendError("That path is a symbolic link; send the real file instead.")

    ext = Path(real).suffix.lower()
    if ext not in policy.extensions or Path(lexical).suffix.lower() != ext:
        allowed = ", ".join(sorted(policy.extensions))
        raise FileSendError(
            f"Files of type '{ext or 'none'}' cannot be sent. Allowed: {allowed}."
        )

    try:
        fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        raise FileSendError(f"No such file: {raw_path}") from None
    except OSError as exc:
        raise FileSendError(f"Cannot open that file ({exc.strerror}).") from None

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise FileSendError("That is not a regular file.")
        if st.st_nlink > 1:
            # A hard link can make a file from elsewhere look local.
            raise FileSendError(
                "That file has several hard links; copy it to a new file first."
            )
        # Re-check what was actually opened: a directory on the way swapped
        # for a link between the checks above and open() ends up here.
        opened = os.path.realpath(f"/proc/self/fd/{fd}")
        if os.path.exists(f"/proc/self/fd/{fd}") and not _within(opened, root_real):
            raise FileSendError(
                "That path leads outside your folder; it cannot be sent."
            )
        if st.st_size == 0:
            raise FileSendError("That file is empty.")
        if st.st_size > policy.max_bytes:
            raise FileSendError(
                f"That file is {st.st_size / 1048576:.1f} MB; the limit is "
                f"{policy.max_bytes / 1048576:.0f} MB. Make it smaller or split it."
            )
        fobj = os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
    return fobj, Path(real), st.st_size


def _slug(text: str) -> str:
    return SLUG_RE.sub("-", text.lower()).strip("-")[:40] or "drawing"


@dataclass
class ReplyFileSender:
    """Posts files as replies to one incoming Telegram message.

    *message* is the PTB ``Message`` being answered. Nothing about the target
    is taken from the model. *drawing*, when set, enables the render tools and
    SVG previews (``ALLOW_DRAWING``).
    """

    message: Any
    policy: FileSendPolicy
    cwd: Path
    drawing: Optional[DrawPolicy] = None
    sent: List[Dict[str, Any]] = field(default_factory=list)
    renders: int = 0

    @property
    def chat_id(self) -> Optional[int]:
        return getattr(self.message, "chat_id", None)

    @property
    def thread_id(self) -> Optional[int]:
        if getattr(self.message, "is_topic_message", False):
            return getattr(self.message, "message_thread_id", None)
        return None

    # -- sending ------------------------------------------------------------

    def _room(self, needed: int) -> None:
        if len(self.sent) + needed > self.policy.max_files:
            raise FileSendError(
                f"Already sent {len(self.sent)} files for this message, the most "
                f"allowed is {self.policy.max_files}"
                + (" (an SVG with a preview counts as two)" if needed > 1 else "")
                + ". Put the rest in one file (or a single .docx/.xlsx with "
                "several sections or sheets, or one contact sheet)."
            )

    @staticmethod
    def _caption(caption: str) -> Optional[str]:
        text = (caption or "").strip()
        if len(text) > CAPTION_LIMIT:
            text = text[: CAPTION_LIMIT - 1] + "…"
        return text or None

    async def _post(
        self, kind: str, data: Any, name: str, caption: Optional[str]
    ) -> None:
        try:
            if kind == "photo":
                await self.message.reply_photo(
                    photo=data,
                    filename=name,
                    caption=caption,
                    read_timeout=60,
                    write_timeout=180,
                )
            else:
                await self.message.reply_document(
                    document=data,
                    filename=name,
                    caption=caption,
                    read_timeout=60,
                    write_timeout=180,
                )
        except Exception as exc:  # Telegram refused or the network failed
            logger.warning(
                "send_file: Telegram did not take the file",
                file=name,
                kind=kind,
                error_type=type(exc).__name__,
                error=str(exc)[:200],
            )
            raise FileSendError(f"Telegram did not accept the file: {exc}") from None
        self.sent.append({"name": name, "kind": kind})
        logger.info(
            "send_file: file sent",
            file=name,
            kind=kind,
            chat_id=self.chat_id,
            thread_id=self.thread_id,
        )

    async def send(
        self,
        raw_path: str,
        caption: str = "",
        preview: bool = False,
        as_photo: bool = False,
        background: Optional[str] = None,
    ) -> str:
        if (preview or as_photo) and self.drawing is None:
            raise FileSendError(
                "Previews and photos need drawing switched on for this agent."
            )
        self._room(2 if preview else 1)
        fobj, real, size = open_confined(raw_path, self.policy, self.cwd)
        ext = real.suffix.lower()
        text = self._caption(caption)

        if ext == ".svg" or preview or as_photo:
            with fobj:
                data = fobj.read(self.policy.max_bytes + 1)
            if ext == ".svg":
                limit = self.drawing.max_svg_bytes if self.drawing else 2 * 1024 * 1024
                try:
                    info = check_svg(data, limit)
                except DrawingError as exc:
                    raise FileSendError(f"Not a safe SVG: {exc}") from None
            if preview and ext != ".svg":
                raise FileSendError(
                    "preview=true is for .svg files; use as_photo for pictures."
                )
            if as_photo:
                if ext not in RASTER_EXTENSIONS or raster_kind(data) is None:
                    raise FileSendError(
                        "as_photo is for real .png/.jpg/.webp pictures; send an SVG "
                        "with preview=true instead."
                    )
                if len(data) > PHOTO_MAX_BYTES:
                    raise FileSendError(
                        "Telegram photos are limited to 10 MB; send it as a file "
                        "(as_photo=false) or render it smaller."
                    )
                w, h = png_size(data)
                if w + h > 10000 or (w and h and max(w / h, h / w) > 20):
                    raise FileSendError(
                        "Too large or too long for a Telegram photo; send it as a file."
                    )
                await self._post("photo", data, real.name, text)
                return (
                    f"Sent {real.name} ({size / 1024:.0f} KB) to the chat as a photo."
                )

            png = None
            if preview:
                try:
                    bg = parse_background(background, "#FFFFFF")
                    w, h = fit(
                        info, min(self.drawing.preview_px, self.drawing.max_render_px)
                    )
                    (png,) = await render_jobs(
                        [
                            {
                                "svg": data.decode("utf-8-sig"),
                                "width": w,
                                "background": bg,
                            }
                        ],
                        self.drawing,
                    )
                except DrawingError as exc:
                    raise FileSendError(
                        f"Could not render the preview: {exc}"
                    ) from None
                write_output(real.with_name(real.stem + ".preview.png"), png)
            await self._post("document", data, real.name, text)
            if png is not None:
                await self._post(
                    "photo", png, real.stem + ".png", f"Preview of {real.name}"
                )
                return f"Sent {real.name} ({size / 1024:.0f} KB) and a PNG preview to the chat."
            return f"Sent {real.name} ({size / 1024:.0f} KB) to the chat."

        with fobj:
            await self._post("document", fobj, real.name, text)
        return f"Sent {real.name} ({size / 1024:.0f} KB) to the chat."

    # -- drawing ------------------------------------------------------------

    def _render_slot(self) -> DrawPolicy:
        if self.drawing is None:
            raise FileSendError("Drawing is switched off for this agent.")
        if self.renders >= self.drawing.max_renders:
            raise FileSendError(
                f"Already rendered {self.renders} times for this message, the most "
                "allowed. Send what you have, or continue in the next message."
            )
        self.renders += 1
        return self.drawing

    def _read_svg(self, raw_path: str, draw: DrawPolicy) -> Tuple[Path, bytes, Any]:
        fobj, real, _size = open_confined(raw_path, self.policy, self.cwd)
        with fobj:
            data = fobj.read(draw.max_svg_bytes + 1)
        if real.suffix.lower() != ".svg":
            raise FileSendError("render_svg takes an .svg file.")
        try:
            info = check_svg(data, draw.max_svg_bytes)
        except DrawingError as exc:
            raise FileSendError(f"Not a safe SVG: {exc}") from None
        return real, data, info

    def _clamp(self, value: Any, default: int, low: int, draw: DrawPolicy) -> int:
        try:
            n = int(value) if value is not None else default
        except (TypeError, ValueError):
            raise FileSendError("size must be a whole number of pixels.") from None
        if n < low or n > draw.max_render_px:
            raise FileSendError(
                f"size must be between {low} and {draw.max_render_px} px."
            )
        return n

    async def render(
        self,
        raw_path: str,
        size: Any = None,
        background: Optional[str] = None,
        small_sizes: bool = True,
    ) -> Tuple[str, List[bytes]]:
        draw = self._render_slot()
        real, data, info = self._read_svg(raw_path, draw)
        px = self._clamp(size, 1024, 16, draw)
        try:
            bg = parse_background(background, None)
        except DrawingError as exc:
            raise FileSendError(str(exc)) from None
        svg = data.decode("utf-8-sig")
        w, h = fit(info, px)
        vw, vh = fit(info, min(px, draw.view_px))
        jobs = [{"svg": svg, "width": w, "background": bg}]
        view_same = (vw, vh) == (w, h)
        if not view_same:
            jobs.append({"svg": svg, "width": vw, "background": bg})
        if small_sizes:
            jobs.append({"svg": svg, "width": fit(info, 32)[0], "background": None})
            jobs.append({"svg": svg, "width": fit(info, 64)[0], "background": None})
        try:
            pngs = await render_jobs(jobs, draw)
            saved = pngs[0]
            view = saved if view_same else pngs[1]
            second = []
            if bg is None:
                second.append({"svg": on_checker_svg(view)})
            if small_sizes:
                second.append({"svg": small_strip_svg(pngs[-2], pngs[-1])})
            extra = await render_jobs(second, draw)
        except DrawingError as exc:
            raise FileSendError(str(exc)) from None
        if bg is None:
            view = extra.pop(0)
        out = real.with_suffix(".png")
        write_output(out, saved)
        images = [view] + extra
        rel = os.path.relpath(out, self.cwd)
        note = (
            f"Rendered {real.name} -> {rel} ({w}x{h} px, "
            f"{'transparent' if bg is None else 'background ' + bg}). "
            "Image 1: the drawing"
            + (" over a checkerboard (= transparent)" if bg is None else "")
            + (f", shown at {vw}x{vh}" if not view_same else "")
            + (
                ". Image 2: at 32 px and 64 px, enlarged, on light and dark."
                if small_sizes
                else "."
            )
            + " Critique it against the checklist before sending."
        )
        return note, images

    async def contact_sheet(
        self,
        paths: Any,
        labels: Any = None,
        columns: Any = None,
        tile: Any = None,
        background: Optional[str] = None,
        out: Optional[str] = None,
    ) -> Tuple[str, List[bytes]]:
        draw = self._render_slot()
        if not isinstance(paths, list) or not paths:
            raise FileSendError("paths must be a list of files.")
        if len(paths) > draw.max_sheet_items:
            raise FileSendError(
                f"At most {draw.max_sheet_items} drawings on one sheet."
            )
        if labels is not None and (
            not isinstance(labels, list) or len(labels) != len(paths)
        ):
            raise FileSendError("labels must be a list with one label per file.")
        n = len(paths)
        cols = (
            columns if columns is not None else (2 if n <= 4 else (3 if n <= 9 else 4))
        )
        try:
            cols = max(1, min(int(cols), 6))
        except (TypeError, ValueError):
            raise FileSendError("columns must be a whole number.") from None
        tsize = self._clamp(tile, 480, 64, draw)
        rows = -(-n // cols)
        # keep the sheet inside the render limit
        tsize = min(
            tsize, (draw.max_render_px - 32) // cols, (draw.max_render_px - 32) // rows
        )
        try:
            bg = parse_background(background, "#FFFFFF")
        except DrawingError as exc:
            raise FileSendError(str(exc)) from None

        jobs, slots, names, rasters = [], [], [], {}
        for i, raw in enumerate(paths):
            fobj, real, _size = open_confined(str(raw), self.policy, self.cwd)
            with fobj:
                data = fobj.read(self.policy.max_bytes + 1)
            names.append(real.name)
            ext = real.suffix.lower()
            if ext == ".svg":
                try:
                    info = check_svg(data, draw.max_svg_bytes)
                except DrawingError as exc:
                    raise FileSendError(f"{real.name}: not a safe SVG: {exc}") from None
                tw, _th = fit(info, tsize)
                slots.append(("job", len(jobs)))
                jobs.append({"svg": data.decode("utf-8-sig"), "width": tw})
            elif ext == ".png" and raster_kind(data) == "png":
                slots.append(("png", i))
                rasters[i] = data
            else:
                raise FileSendError(
                    f"{real.name}: a contact sheet takes .svg and .png files."
                )
        try:
            rendered = await render_jobs(jobs, draw)
        except DrawingError as exc:
            raise FileSendError(str(exc)) from None
        tiles = []
        for i, (kind, ref) in enumerate(slots):
            png = rendered[ref] if kind == "job" else rasters[ref]
            label = str(labels[i]) if labels else Path(names[i]).stem
            tiles.append((png, label))
        sheet_svg, W, H = contact_sheet_svg(tiles, cols, tsize, bg)
        vw = min(W, draw.view_px)
        try:
            sheet_jobs = [{"svg": sheet_svg}]
            if vw != W:
                sheet_jobs.append({"svg": sheet_svg, "width": vw})
            sheet = await render_jobs(sheet_jobs, draw)
        except DrawingError as exc:
            raise FileSendError(str(exc)) from None
        default = f"drawings/{_slug(Path(names[0]).stem.split('-')[0])}-sheet-{time.strftime('%Y%m%d-%H%M%S')}.png"
        target = confined_output(out or default, self.policy.root, self.cwd, ".png")
        write_output(target, sheet[0])
        rel = os.path.relpath(target, self.cwd)
        note = (
            f"Contact sheet of {n} drawings saved to {rel} ({W}x{H} px). "
            f'Send it with send_file("{rel}", caption, as_photo=true).'
        )
        return note, [sheet[-1]]


class _ToolServer:
    """The minimum the Agent SDK needs from an in-process MCP server."""

    def __init__(self, sender: ReplyFileSender):
        from mcp.types import CallToolRequest, ListToolsRequest

        self.name = SERVER_NAME
        self.version = "1.1.0"
        self._sender = sender
        self.request_handlers = {
            ListToolsRequest: self._list_tools,
            CallToolRequest: self._call_tool,
        }

    def tools(self) -> List[Tuple[str, str, Dict[str, Any]]]:
        drawing = self._sender.drawing is not None
        out = [
            (
                TOOL_NAME,
                TOOL_DESCRIPTION + (DRAW_SEND_NOTE if drawing else ""),
                _send_schema(drawing),
            )
        ]
        if drawing:
            out.append((RENDER_TOOL_NAME, RENDER_DESCRIPTION, RENDER_SCHEMA))
            out.append((SHEET_TOOL_NAME, SHEET_DESCRIPTION, SHEET_SCHEMA))
        return out

    async def _list_tools(self, _request: Any) -> Any:
        tools = [
            SimpleNamespace(
                name=name,
                description=desc,
                inputSchema=schema,
                annotations=None,
                meta=None,
            )
            for name, desc, schema in self.tools()
        ]
        return SimpleNamespace(root=SimpleNamespace(tools=tools))

    async def _dispatch(
        self, name: str, args: Dict[str, Any]
    ) -> Tuple[str, List[bytes]]:
        s = self._sender
        if name == TOOL_NAME:
            return (
                await s.send(
                    str(args.get("path", "")),
                    str(args.get("caption", "") or ""),
                    preview=bool(args.get("preview", False)),
                    as_photo=bool(args.get("as_photo", False)),
                    background=args.get("background"),
                ),
                [],
            )
        if name == RENDER_TOOL_NAME and s.drawing is not None:
            return await s.render(
                str(args.get("path", "")),
                size=args.get("size"),
                background=args.get("background"),
                small_sizes=bool(args.get("small_sizes", True)),
            )
        if name == SHEET_TOOL_NAME and s.drawing is not None:
            return await s.contact_sheet(
                args.get("paths"),
                labels=args.get("labels"),
                columns=args.get("columns"),
                tile=args.get("tile"),
                background=args.get("background"),
                out=args.get("out"),
            )
        raise LookupError(name)

    async def _call_tool(self, request: Any) -> Any:
        import base64

        params = getattr(request, "params", None)
        name = getattr(params, "name", None)
        args = getattr(params, "arguments", None) or {}
        is_error = False
        images: List[bytes] = []
        try:
            text, images = await self._dispatch(str(name), args)
        except LookupError:
            text, is_error = f"Unknown tool: {name}", True
        except FileSendError as exc:
            verb = "Not sent" if name == TOOL_NAME else "Not rendered"
            text, is_error = f"{verb}: {exc}", True
        except Exception as exc:  # never let a bug kill the Claude run
            logger.exception("joya_files tool failed", tool=name)
            text, is_error = (
                f"Failed: internal error ({type(exc).__name__}).",
                True,
            )
        content = [SimpleNamespace(type="text", text=text)]
        for png in images:
            content.append(
                SimpleNamespace(
                    type="image",
                    data=base64.b64encode(png).decode("ascii"),
                    mimeType="image/png",
                )
            )
        return SimpleNamespace(root=SimpleNamespace(content=content, isError=is_error))


def build_file_tool_server(sender: ReplyFileSender) -> Dict[str, Any]:
    """An ``McpSdkServerConfig`` for ``ClaudeAgentOptions.mcp_servers``."""
    return {"type": "sdk", "name": SERVER_NAME, "instance": _ToolServer(sender)}


def tool_names(sender: ReplyFileSender) -> List[str]:
    """Qualified names of the tools this sender's server offers (for allowed_tools)."""
    names = [TOOL_NAME] + (
        list(DRAWING_TOOL_NAMES) if sender.drawing is not None else []
    )
    return [qualified(n) for n in names]


def make_reply_file_sender(
    settings: Any, message: Any, cwd: Path
) -> Optional[ReplyFileSender]:
    """A sender bound to *message*, or None when file sending is off.

    Drawing (render tools, SVG previews) comes with it when ALLOW_DRAWING is on
    and the renderer is installed; it needs file sending, so it is never on alone.
    """
    if not getattr(settings, "allow_file_send", False) or message is None:
        return None
    drawing = None
    if getattr(settings, "allow_drawing", False):
        from .drawing import renderer_available

        if renderer_available():
            drawing = DrawPolicy.from_settings(settings)
        else:
            logger.warning("ALLOW_DRAWING is on but resvg-py is not installed")
    return ReplyFileSender(
        message=message,
        policy=FileSendPolicy.from_settings(settings),
        cwd=Path(cwd),
        drawing=drawing,
    )


FILE_GUIDE = """# SENDING FILES (Word, PDF, Excel)
You can send files into this chat with the `send_file` tool (path, caption). It posts the file as a document in the same chat and topic you are answering; you cannot pick another chat. Up to {max_files} files per message, {max_mb} MB each, types: {exts}.

Make the file inside your working folder first (e.g. `outbox/<name>`), then call send_file once per file with a short caption, then say in one line what you sent. Never claim a file was sent unless send_file answered "Sent".

Python (`python`) has these libraries: python-docx (`import docx`), openpyxl, reportlab, arabic_reshaper, bidi (python-bidi), pypdf. Write the script to a .py file in your folder and run it with `python`.
- Word: python-docx. Arabic paragraphs: set `paragraph.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.RIGHT` and mark runs right-to-left (`run._element.get_or_add_rPr()` + `w:rtl`); Word shapes Arabic itself, do not reshape.
- Excel: openpyxl. Arabic sheets: `ws.sheet_view.rightToLeft = True`; Excel shapes Arabic itself. Put numbers in as numbers, not text.
- PDF: reportlab. Its fonts have no Arabic: register a TTF that has it, and for every Arabic string draw `get_display(arabic_reshaper.reshape(text))` (from bidi.algorithm import get_display), right-aligned (TA_RIGHT); in tables, list RTL columns right to left. Arabic font on this server: {arabic_font}.
- After making a file, check it opens (e.g. pypdf page count / text, openpyxl load_workbook, docx.Document) before sending.
"""

# Fonts that render Arabic, best first. DejaVu Sans is what this server has.
ARABIC_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/truetype/fonts-arabeyes/ae_AlArabiya.ttf",
    "/usr/share/fonts/truetype/amiri/amiri-regular.ttf",
    "/usr/share/fonts/opentype/fonts-hosny-amiri/Amiri-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
)


def arabic_font_path() -> Optional[str]:
    for candidate in ARABIC_FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


def file_guide(settings: Any, drawing: Optional[DrawPolicy] = None) -> str:
    """The system-prompt section that tells Claude how to make and send files.

    With *drawing*, the design playbook for code-drawn pictures follows it.
    """
    font = arabic_font_path()
    text = FILE_GUIDE.format(
        max_files=int(settings.file_send_max_per_reply),
        max_mb=int(settings.file_send_max_mb),
        exts=", ".join(sorted(ALLOWED_EXTENSIONS)),
        arabic_font=(
            f"`{font}`"
            if font
            else "none found -- tell the user Arabic PDFs need a font installed"
        ),
    )
    if drawing is not None:
        text += "\n" + drawing_guide(drawing)
    return text
