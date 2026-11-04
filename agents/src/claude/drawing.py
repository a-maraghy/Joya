"""Pictures the agent draws in code: SVG checks, PNG rendering, contact sheets.

The agent has no image-generation service. It draws: it writes SVG (logos,
icons, badges, illustrations) and this module turns that SVG into PNG so that

* the model can LOOK at what it drew (``render_svg`` returns the PNG to Claude
  as an image content block, which the Agent SDK forwards to the CLI), judge it
  against the design checklist in :data:`DRAWING_GUIDE`, and refine it;
* several variants can be laid side by side on one contact sheet;
* the person gets a PNG preview next to the vector file.

Rendering is resvg (``resvg-py``, a self-contained wheel: no libcairo, no
network, no scripting). It runs in a child process with a memory and CPU
limit and a timeout, so a hostile or merely enormous drawing cannot take the
bot down with it.

An SVG is untrusted XML -- it may be something the agent was handed, not only
something it wrote -- so before it is rendered or sent, :func:`check_svg`
refuses DOCTYPE/entities (XXE, billion laughs), scripts, event handlers,
``<foreignObject>``, embedded HTML, and every reference that leaves the file
(``href``/``url()`` other than ``#id`` fragments and inline raster
``data:image/...`` URIs). It is a deny-by-default check of references, not a
full sanitiser: a file that fails is refused, never rewritten.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from functools import lru_cache
from html import escape as _esc
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

SVG_NS = "http://www.w3.org/2000/svg"
XHTML_NS = "http://www.w3.org/1999/xhtml"
RASTER_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})

# Elements that run code, embed another document, or pull media in.
FORBIDDEN_ELEMENTS = frozenset(
    {
        "script",
        "foreignobject",
        "iframe",
        "embed",
        "object",
        "audio",
        "video",
        "canvas",
        "handler",
        "listener",
        "html",
        "body",
        "meta",
        "link",
        "base",
    }
)
ANIMATION_ELEMENTS = frozenset({"set", "animate", "animatemotion", "animatetransform"})
MAX_ELEMENTS = 20000
# Inline raster images are self-contained and fine; nothing else is.
DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$", re.I
)
URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
BACKGROUND_RE = re.compile(
    r"^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-z]{3,20})$"
)
BACKGROUND_NAMES = {
    "white": "#FFFFFF",
    "light": "#FFFFFF",
    "black": "#000000",
    "dark": "#0D1117",
}
LABEL_FONT = "DejaVu Sans"


class DrawingError(Exception):
    """A drawing that cannot be rendered or sent; the text is shown to Claude."""


@dataclass(frozen=True)
class DrawPolicy:
    """How big, how many, how long."""

    max_render_px: int = 2048  # longest edge of any PNG written or sent
    max_svg_bytes: int = 2 * 1024 * 1024
    max_renders: int = 12  # render_svg + contact_sheet calls per reply
    view_px: int = 1024  # the copy Claude looks at
    preview_px: int = 1024  # the PNG sent next to an SVG
    max_sheet_items: int = 12
    timeout: float = 45.0
    memory_bytes: int = 2 * 1024 * 1024 * 1024

    @classmethod
    def from_settings(cls, settings: Any) -> "DrawPolicy":
        return cls(
            max_render_px=int(settings.draw_max_render_px),
            max_svg_bytes=int(settings.svg_max_kb) * 1024,
            max_renders=int(settings.draw_max_renders_per_reply),
        )


@dataclass(frozen=True)
class SvgInfo:
    width: float
    height: float

    @property
    def aspect(self) -> float:
        return self.width / self.height if self.height else 1.0


# ------------------------------------------------------------------ checks --


def _local(tag: str) -> Tuple[str, str]:
    """('{ns}name') -> (ns, lower-case name)."""
    if tag.startswith("{"):
        ns, _, name = tag[1:].partition("}")
        return ns, name.lower()
    return "", tag.lower()


def _check_reference(value: str, where: str) -> None:
    v = value.strip()
    if not v or v.startswith("#"):
        return
    if DATA_IMAGE_RE.match(v):
        return
    raise DrawingError(
        f"{where} points outside the drawing ({v[:60]!r}); only #id references "
        "and inline data:image/png|jpeg|gif|webp are allowed. Draw it instead, or "
        "embed the picture as base64."
    )


def _check_css(text: str, where: str) -> None:
    low = text.lower()
    if "@import" in low:
        raise DrawingError(f"{where}: @import is not allowed in an SVG.")
    if "javascript:" in low or "expression(" in low:
        raise DrawingError(f"{where}: script in CSS is not allowed.")
    for _q, target in URL_RE.findall(text):
        _check_reference(target, where + " url()")


def _number(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    m = re.match(r"^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$", value)
    return float(m.group(1)) if m else None


def check_svg(data: bytes, max_bytes: int = 2 * 1024 * 1024) -> SvgInfo:
    """Refuse an SVG that could run code, read files or reach the network.

    Returns the drawing's intrinsic size (from viewBox, else width/height,
    else 1:1) so renders keep its proportions.
    """
    if not data:
        raise DrawingError("That SVG is empty.")
    if len(data) > max_bytes:
        raise DrawingError(
            f"That SVG is {len(data) / 1024:.0f} KB; the limit is "
            f"{max_bytes / 1024:.0f} KB. Simplify the paths (fewer points, "
            "rounded coordinates) or reuse shapes with <use>."
        )
    if data[:2] == b"\x1f\x8b":
        raise DrawingError("Compressed SVG (.svgz) is not accepted; save plain SVG.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise DrawingError("That SVG is not UTF-8 text.") from None
    low = text.lower()
    if "<!doctype" in low or "<!entity" in low:
        raise DrawingError(
            "That SVG has a DOCTYPE or entity declaration; remove it (it is not needed)."
        )
    if "<?xml-stylesheet" in low:
        raise DrawingError("External stylesheets are not allowed in an SVG.")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise DrawingError(f"That SVG is not well-formed XML: {exc}.") from None
    ns, name = _local(root.tag)
    if name != "svg" or ns not in ("", SVG_NS):
        raise DrawingError("That file is not an SVG drawing (its root is not <svg>).")

    count = 0
    for el in root.iter():
        count += 1
        if count > MAX_ELEMENTS:
            raise DrawingError(
                f"That SVG has more than {MAX_ELEMENTS} elements; simplify it."
            )
        if not isinstance(el.tag, str):  # comments / processing instructions
            continue
        ens, ename = _local(el.tag)
        if ens == XHTML_NS or ename in FORBIDDEN_ELEMENTS:
            raise DrawingError(
                f"<{ename}> is not allowed in an SVG here (scripts, embedded HTML "
                "and foreign content are refused)."
            )
        if ename in ANIMATION_ELEMENTS:
            target = (el.get("attributeName") or "").lower()
            if target.endswith("href"):
                raise DrawingError("Animating a link (href) is not allowed.")
        if ename == "style" and el.text:
            _check_css(el.text, "<style>")
        for attr, value in el.attrib.items():
            _ans, aname = _local(attr)
            if aname.startswith("on"):
                raise DrawingError(f"Event handler attribute '{aname}' is not allowed.")
            if "javascript:" in value.lower():
                raise DrawingError("javascript: is not allowed in an SVG.")
            if aname in ("href", "src"):
                _check_reference(value, f"<{ename} {aname}>")
            elif aname == "style":
                _check_css(value, f"<{ename} style>")
            elif "url(" in value.lower():
                for _q, target in URL_RE.findall(value):
                    _check_reference(target, f"<{ename} {aname}>")

    vb = root.get("viewBox") or root.get("viewbox")
    if vb:
        parts = re.split(r"[\s,]+", vb.strip())
        try:
            w, h = float(parts[2]), float(parts[3])
            if w > 0 and h > 0:
                return SvgInfo(w, h)
        except (IndexError, ValueError):
            pass
    w, h = _number(root.get("width")), _number(root.get("height"))
    if w and h:
        return SvgInfo(w, h)
    return SvgInfo(1.0, 1.0)


def png_size(data: bytes) -> Tuple[int, int]:
    """(width, height) from a PNG header, or (0, 0)."""
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        return struct.unpack(">II", data[16:24])
    return (0, 0)


def raster_kind(data: bytes) -> Optional[str]:
    """'png' / 'jpeg' / 'webp' by magic bytes, else None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def parse_background(
    value: Optional[str], default: Optional[str] = None
) -> Optional[str]:
    """None/'transparent' -> None; 'light'/'dark'/'#hex'/css name -> colour."""
    if value is None:
        return default
    v = str(value).strip().lower()
    if v in ("", "none", "transparent"):
        return None
    if v in BACKGROUND_NAMES:
        return BACKGROUND_NAMES[v]
    if not BACKGROUND_RE.match(v):
        raise DrawingError(
            "background must be transparent, light, dark, a #hex colour or a CSS colour name."
        )
    return v


def fit(info: SvgInfo, longest: int) -> Tuple[int, int]:
    """Pixel size whose longest edge is *longest*, keeping the aspect ratio."""
    a = info.aspect
    if a >= 1:
        return longest, max(1, round(longest / a))
    return max(1, round(longest * a)), longest


# --------------------------------------------------------------- rendering --

# The child: reads a JSON list of jobs on stdin, writes each PNG length-prefixed.
_WORKER = r"""
import json, resource, struct, sys
a = json.loads(sys.argv[1])
resource.setrlimit(resource.RLIMIT_AS, (a["mem"], a["mem"]))
resource.setrlimit(resource.RLIMIT_CPU, (a["cpu"], a["cpu"]))
import resvg_py
jobs = json.loads(sys.stdin.buffer.read().decode("utf-8"))
out = sys.stdout.buffer
for job in jobs:
    kw = dict(svg_string=job["svg"], resources_dir=a["res"])
    for k in ("width", "height", "background"):
        if job.get(k) is not None:
            kw[k] = job[k]
    try:
        png = bytes(resvg_py.svg_to_bytes(**kw))
    except Exception as exc:
        msg = str(exc).encode("utf-8", "replace")[:500]
        out.write(b"E" + struct.pack(">I", len(msg)) + msg)
        continue
    out.write(b"P" + struct.pack(">I", len(png)) + png)
out.flush()
"""


def renderer_available() -> bool:
    try:
        import resvg_py  # noqa: F401
    except Exception:
        return False
    return True


def _run_worker(jobs: List[Dict[str, Any]], policy: DrawPolicy) -> List[bytes]:
    with tempfile.TemporaryDirectory(prefix="joya-render-") as res:
        args = json.dumps(
            {"mem": policy.memory_bytes, "cpu": int(policy.timeout) + 5, "res": res}
        )
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-c", _WORKER, args],
                input=json.dumps(jobs).encode("utf-8"),
                capture_output=True,
                timeout=policy.timeout,
                cwd=res,
            )
        except subprocess.TimeoutExpired:
            raise DrawingError(
                f"Rendering took longer than {policy.timeout:.0f} s; simplify the "
                "drawing (fewer filters, smaller blur, fewer elements)."
            ) from None
    data = proc.stdout
    if proc.returncode != 0 and not data:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        tail = err[-1] if err else f"exit {proc.returncode}"
        if "No module named" in tail and "resvg" in tail:
            raise DrawingError(
                "The SVG renderer (resvg-py) is not installed on this server."
            )
        raise DrawingError(f"The renderer failed ({tail[:200]}).")
    out: List[bytes] = []
    i = 0
    while i < len(data):
        kind = data[i : i + 1]
        (n,) = struct.unpack(">I", data[i + 1 : i + 5])
        body = data[i + 5 : i + 5 + n]
        i += 5 + n
        if kind == b"E":
            raise DrawingError(
                "The renderer could not draw that SVG: "
                + body.decode("utf-8", "replace")
            )
        out.append(body)
    if len(out) != len(jobs):
        raise DrawingError(
            "The renderer stopped early (out of memory or time?); simplify the drawing."
        )
    return out


async def render_jobs(jobs: List[Dict[str, Any]], policy: DrawPolicy) -> List[bytes]:
    """Render several SVG strings in one child process, off the event loop."""
    if not jobs:
        return []
    return await asyncio.to_thread(_run_worker, jobs, policy)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


CHECKER = (
    '<pattern id="chk" width="16" height="16" patternUnits="userSpaceOnUse">'
    '<rect width="16" height="16" fill="#FFFFFF"/>'
    '<rect width="8" height="8" fill="#E4E7EB"/>'
    '<rect x="8" y="8" width="8" height="8" fill="#E4E7EB"/></pattern>'
)


def on_checker_svg(png: bytes) -> str:
    """A transparent PNG shown over a checkerboard, so Claude can see what is see-through."""
    w, h = png_size(png)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f'<defs>{CHECKER}</defs><rect width="{w}" height="{h}" fill="url(#chk)"/>'
        f'<image width="{w}" height="{h}" href="data:image/png;base64,{_b64(png)}"/></svg>'
    )


def small_strip_svg(png32: bytes, png64: bytes) -> str:
    """The drawing at 32 px and 64 px, blown up with hard pixels, on light and dark.

    This is how a favicon or an app icon really looks; fine lines that vanish
    and shapes that merge show up here and not in a big render.
    """
    tiles = [
        (png32, 32, "#FFFFFF", "32 px · light"),
        (png32, 32, "#0D1117", "32 px · dark"),
        (png64, 64, "#FFFFFF", "64 px · light"),
        (png64, 64, "#0D1117", "64 px · dark"),
    ]
    cell, pad, label = 160, 16, 22
    W = len(tiles) * (cell + pad) + pad
    H = cell + 2 * pad + label
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
        f'<rect width="{W}" height="{H}" fill="#F3F4F6"/>',
    ]
    for i, (png, px, bg, text) in enumerate(tiles):
        x = pad + i * (cell + pad)
        w, h = png_size(png)
        scale = 4 if px == 32 else 2
        dw, dh = w * scale, h * scale
        ox, oy = x + (cell - dw) / 2, pad + (cell - dh) / 2
        parts.append(
            f'<rect x="{x}" y="{pad}" width="{cell}" height="{cell}" fill="{bg}"/>'
        )
        parts.append(
            f'<image x="{ox}" y="{oy}" width="{dw}" height="{dh}" image-rendering="optimizeSpeed" '
            f'href="data:image/png;base64,{_b64(png)}"/>'
        )
        parts.append(
            f'<text x="{x + cell / 2}" y="{pad + cell + 18}" text-anchor="middle" '
            f'font-family="{LABEL_FONT}" font-size="13" fill="#374151">{_esc(text)}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def contact_sheet_svg(
    tiles: Sequence[Tuple[bytes, str]],
    columns: int,
    tile: int,
    background: Optional[str],
) -> Tuple[str, int, int]:
    """Lay rendered PNGs out in a grid with a label under each."""
    n = len(tiles)
    cols = max(1, min(columns, n))
    rows = math.ceil(n / cols)
    pad, label = max(16, tile // 16), max(20, tile // 12)
    fsize = max(12, label * 0.6)
    W = cols * tile + (cols + 1) * pad
    H = rows * (tile + label) + (rows + 1) * pad
    dark = bool(background) and background.lower() in ("#0d1117", "#000000", "black")
    ink = "#E6EDF3" if dark else "#374151"
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
    ]
    parts.append(f"<defs>{CHECKER}</defs>")
    parts.append(f'<rect width="{W}" height="{H}" fill="{background or "url(#chk)"}"/>')
    for i, (png, text) in enumerate(tiles):
        r, c = divmod(i, cols)
        x = pad + c * (tile + pad)
        y = pad + r * (tile + label + pad)
        w, h = png_size(png) or (tile, tile)
        s = min(tile / w, tile / h) if w and h else 1
        dw, dh = w * s, h * s
        parts.append(
            f'<image x="{x + (tile - dw) / 2:.1f}" y="{y + (tile - dh) / 2:.1f}" '
            f'width="{dw:.1f}" height="{dh:.1f}" href="data:image/png;base64,{_b64(png)}"/>'
        )
        if text:
            parts.append(
                f'<text x="{x + tile / 2}" y="{y + tile + label * 0.8:.1f}" text-anchor="middle" '
                f'font-family="{LABEL_FONT}" font-size="{fsize:.0f}" fill="{ink}">{_esc(text[:60])}</text>'
            )
    parts.append("</svg>")
    return "".join(parts), W, H


def write_output(path: Path, data: bytes) -> None:
    """Write *data* to *path* (already confined) atomically, never through a link."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        path.unlink()
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".render-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o660)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ------------------------------------------------------------------- fonts --

FONT_PREFERENCE = (
    "DejaVu Sans",
    "DejaVu Serif",
    "Liberation Sans",
    "Liberation Serif",
    "Ubuntu",
    "Ubuntu Sans",
    "Quicksand",
    "Nimbus Sans",
    "URW Gothic",
    "URW Bookman",
    "C059",
    "P052",
    "Z003",
    "FreeSans",
    "FreeSerif",
    "Noto Color Emoji",
)


@lru_cache(maxsize=1)
def installed_fonts() -> Tuple[str, ...]:
    """Font families on this machine, best known first (fc-list)."""
    try:
        out = subprocess.run(
            ["fc-list", ":", "family"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return ()
    fams = set()
    for line in out.splitlines():
        first = line.split(",")[0].strip()
        if first:
            fams.add(first.replace("\\", ""))
    ordered = [f for f in FONT_PREFERENCE if f in fams]
    return tuple(ordered)


# ------------------------------------------------------------------- guide --

DRAWING_GUIDE = r"""# DRAWING PICTURES (logos, icons, badges, illustrations)
You make images by DRAWING them in SVG code -- there is no image-generation model here, and you do not need one. Treat every image request as a design job and spend real effort: a good brand designer works in concepts, construction and iteration, not in one try.

Tools: `render_svg(path, size?, background?)` renders an SVG in your folder to PNG (saved next to it) and SHOWS YOU the picture plus a 32 px / 64 px strip on light and dark -- use it to look at your work. `contact_sheet(paths, labels?, columns?, background?)` puts several drawings side by side on one PNG and shows it to you. `send_file(path, caption, preview=true, background?)` sends an SVG as the real vector file plus a PNG preview; `send_file(png, caption, as_photo=true)` posts a PNG/JPG as a photo. Limits: renders up to {max_px} px on the long edge, {max_renders} renders per message, SVG up to {svg_kb} KB.

## Process (do all of it)
1. Brief: who is it for, where will it be seen (favicon? sign? app icon? T-shirt?), mood words, colours to use or avoid, must-have text. If the brief is thin, choose sensible answers yourself and state them in one line -- do not stall with questions.
2. Concepts: sketch 3-4 genuinely DIFFERENT ideas (a symbol, a lettermark, an abstract mark, an emblem...), not one idea in four colours. Name each in 3-5 words.
3. Draw each as its own file: `<slug>-<style>-v1.svg`, e.g. `mavix-geometric-v1.svg`, in `drawings/` in your folder.
4. Render and LOOK (`render_svg`, or `contact_sheet` for the set). Critique honestly against the checklist below; write the critique down briefly for yourself.
5. Refine at least once: fix every checklist failure, save as `-v2.svg`, render again. Stop when it passes, not before.
6. Deliver: for variants, send the contact sheet first (as_photo) and ask which to develop; for a final, send the SVG with `preview=true` and say in one line what it is. Offer light and dark versions where it matters.

## Checklist (judge the render, not your code)
- Balance: visual weight centred; optical centre sits slightly ABOVE the geometric centre; circles/points overshoot flat edges by ~1-3% so they look the same size.
- Silhouette: recognisable as a solid black shape at 32 px. Lines thinner than ~1/24 of the icon vanish at small sizes.
- Contrast: shapes and text readable on the intended background (aim for WCAG 4.5:1 for text, 3:1 for shapes); check both light and dark.
- Legibility: text readable at 512 px and the mark still works at 32 px without the text.
- Colour: 2-4 colours, one dominant, one accent; no muddy mid-tones meeting each other; gradients go between related hues.
- Craft: nothing clipped by the viewBox, even spacing, consistent stroke widths and corner radii, aligned to the grid, no stray points or hairline gaps between shapes.
- Concept: does it say the brief in one look? Would it still work in one colour?

## Construction techniques
- viewBox first: design on a clean grid, e.g. `viewBox="0 0 512 512"` with a 32-unit grid and ~10% safe margin. Use whole or half units.
- Geometry: build from circles, rounded rects and arcs (`A`), then combine; symmetric marks: draw one half and mirror it with `<use href="#half" transform="matrix(-1 0 0 1 512 0)"/>`; radial repeats with `<use transform="rotate(45 256 256)"/>`.
- Curves: cubic Beziers (`C`) with handles about 0.55 x radius make smooth, circle-like arcs; keep handles on the tangent for G1-smooth joins; quadratic `Q` for simple swoops.
- Negative space: cut shapes out with `<mask>` (white = keep, black = cut) or `fill-rule="evenodd"`; a hidden second meaning in the counter-space is what makes marks memorable.
- Gradients: `linearGradient`/`radialGradient` with `gradientUnits="userSpaceOnUse"` so they line up across shapes; mesh-like depth = layer 2-3 radial gradients with low-opacity stops over a base fill.
- clipPath to keep highlights/textures inside a shape; masks for soft fades (gradient inside the mask).
- Filters, sparingly: glow = `feGaussianBlur` of a copy behind the shape (opacity 0.5-0.8); drop shadow = `feDropShadow dx="0" dy="6" stdDeviation="8" flood-opacity=".25"`; grain = `feTurbulence type="fractalNoise" baseFrequency="0.9"` + `feColorMatrix` to low alpha, composited `in2="SourceGraphic" operator="in"`; hand-drawn wobble = `feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2"` + `feDisplacementMap scale="2-4"` (this renderer displaces strongly: 8 already shreds a stroke -- render and check). Give filters a region (`x="-20%" y="-20%" width="140%" height="140%"`) so glows are not cut off. Big blurs are slow -- keep stdDeviation modest.
- `<pattern>` for dots, stripes, halftone; stroke vs fill: line-art uses one stroke width with round caps/joins; flat art uses fills only. `vector-effect="non-scaling-stroke"` keeps hairlines constant if scaled.
- Reuse with `<defs>` + `<use>`; round coordinates to 1-2 decimals to keep files small.

## Typography
- Fonts installed here: {fonts}. Name them exactly in `font-family` (with a generic fallback); nothing else is available, and the person's device may not have them either.
- For a FINAL logo, prefer lettering drawn as paths (geometric letters from rects/arcs, or hand-built shapes) so it looks identical everywhere; if you keep `<text>`, say it needs the font. Tune letter-spacing (wordmarks usually +2..+8%), and check kerning pairs like AV, VA, WA, LT visually.
- Arabic: the renderer here shapes Arabic correctly with DejaVu Sans (joined letters, right to left); put Arabic in its own `<text>` with `direction="rtl"` and `text-anchor="end"` at the right edge. Other viewers may not have the font: for a final Arabic logo, offer path-based lettering, and always render to check the joins.

## Styles cookbook (starting points -- adapt, do not paste)
- Minimalist: one idea, 1-2 colours, generous space. `<circle cx="256" cy="256" r="160" fill="#0A3A35"/><path d="M256 140v232" stroke="#00E6A5" stroke-width="28" stroke-linecap="round"/>`
- Geometric: grid-built shapes, repetition, rotation. `<g id="p"><path d="M256 96L352 256H160Z" fill="#2B59C3"/></g><use href="#p" transform="rotate(120 256 256)"/><use href="#p" transform="rotate(240 256 256)"/>`
- Abstract: overlapping translucent forms that suggest the idea. `<g style="mix-blend-mode:multiply"><circle cx="210" cy="256" r="120" fill="#FF6B6B" opacity=".85"/><circle cx="302" cy="256" r="120" fill="#4ECDC4" opacity=".85"/></g>`
- Hand-drawn: roughen with a displacement filter, or jitter path points. `<filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="3"/></filter><path filter="url(#rough)" d="M120 300C180 180 330 180 392 300" fill="none" stroke="#222" stroke-width="10" stroke-linecap="round"/>`
- Flat illustration: big simple shapes, 3-5 colours, no outlines, one light direction shown with a slightly darker shade shape. `<rect y="320" width="512" height="192" fill="#7BC67E"/><circle cx="380" cy="130" r="56" fill="#FFD166"/><path d="M0 330 140 190 260 330Z" fill="#4A7C59"/>`
- Isometric: 30 degree axes, three faces with three tones of one hue. `<path d="M256 120 376 190 256 260 136 190Z" fill="#8FD3FF"/><path d="M136 190 256 260V400L136 330Z" fill="#3E8ED0"/><path d="M376 190 256 260V400L376 330Z" fill="#2A6BA8"/>`
- Line art: one stroke width, round caps and joins, no fills. `<g fill="none" stroke="#1F2937" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><path d="M160 360V200L256 136 352 200V360Z"/><path d="M224 360V280H288V360"/></g>`
- Badge / emblem: a container (circle, shield, hexagon) + symbol + text on a circular path. `<path id="arc" d="M96 256A160 160 0 0 1 416 256" fill="none"/><circle cx="256" cy="256" r="200" fill="#14213D"/><circle cx="256" cy="256" r="180" fill="none" stroke="#FCA311" stroke-width="6"/><text font-family="DejaVu Sans" font-size="34" letter-spacing="6" fill="#FCA311"><textPath href="#arc" startOffset="50%" text-anchor="middle">MAVIX</textPath></text>`
- AI-glow (like JOYA AI): dark ground, a violet-to-joya gradient shape, a blurred copy behind it for the halo, a bright four-point spark. `<linearGradient id="g" x1="0" y1="512" x2="512" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00E6A5"/><stop offset="1" stop-color="#8A2BE2"/></linearGradient><filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="14"/></filter><circle cx="256" cy="256" r="150" fill="url(#g)" filter="url(#glow)" opacity=".7"/><circle cx="256" cy="256" r="150" fill="url(#g)"/><path d="M256 150C262 230 282 250 362 256C282 262 262 282 256 362C250 282 230 262 150 256C230 250 250 230 256 150Z" fill="#F2FFF9"/>`

## Palettes
Pick 2-4 colours: a dominant (60%), a secondary (30%), an accent (10%). Start from the brief's mood (trust: deep blue/teal; growth: greens; energy: orange/coral; premium: near-black + gold/cream; tech: dark + one electric hue). Check contrast of each pair you put next to each other; avoid pure #000 on pure #FFF for large areas (use #0D1117 / #F8FAFC). Make a light version (dark ink on light) and a dark version (light ink on dark) -- render both with `background="light"` and `background="dark"`.

## Output conventions
- `viewBox` always, no fixed px width/height (or width/height equal to the viewBox numbers); centred in the box with a margin.
- Transparent background unless asked (no full-size background rect) -- except illustrations/scenes, which own their background.
- Keep logos and icons under ~50 KB; illustrations may be bigger.
- Give ids short unique prefixes (`mvx-g1`) so drawings can be combined.
- Allowed inside an SVG: shapes, paths, text, gradients, patterns, masks, clipPaths, filters, `<use>`, inline `data:image/png;base64,...`. Refused: scripts, event handlers, `<foreignObject>`, links or `url()` to anything outside the file, DOCTYPE/entities.

## Honesty
You draw vector art, not photographs. If asked for something photoreal (a photo of a person, a product shot), say so plainly in one line and offer an illustrated take instead (flat, isometric, line art, or a stylised scene). Never claim a picture was sent unless send_file answered "Sent". Drawing here costs nothing beyond the conversation itself; say so if asked about cost.
"""


def drawing_guide(policy: DrawPolicy) -> str:
    fonts = installed_fonts()
    return DRAWING_GUIDE.format(
        max_px=policy.max_render_px,
        max_renders=policy.max_renders,
        svg_kb=policy.max_svg_bytes // 1024,
        fonts=", ".join(fonts) if fonts else "none found (draw letters as paths)",
    )
