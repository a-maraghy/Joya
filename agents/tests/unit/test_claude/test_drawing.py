"""Pictures drawn in code: SVG checks, rendering, the look-at-it loop, previews."""

import base64
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from claude_agent_sdk._internal.query import Query

from src.claude.drawing import (
    DrawingError,
    DrawPolicy,
    check_svg,
    drawing_guide,
    fit,
    parse_background,
    png_size,
    renderer_available,
)
from src.claude.file_send import (
    RENDER_TOOL_NAME,
    SHEET_TOOL_NAME,
    TOOL_NAME,
    FileSendError,
    FileSendPolicy,
    ReplyFileSender,
    build_file_tool_server,
    file_guide,
    make_reply_file_sender,
    tool_names,
)
from src.claude.sdk_integration import ClaudeSDKManager
from src.config.settings import Settings

needs_renderer = pytest.mark.skipif(
    not renderer_available(), reason="resvg-py is not installed"
)

GOOD = b"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00E6A5"/><stop offset="1" stop-color="#8A2BE2"/></linearGradient>
<filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>
<mask id="m"><rect width="200" height="100" fill="#fff"/><circle cx="100" cy="50" r="10" fill="#000"/></mask>
<path id="p" d="M10 90L50 10L90 90Z"/>
</defs>
<style>.a { fill: url(#g); }</style>
<g mask="url(#m)"><rect class="a" width="200" height="100" rx="12"/></g>
<use href="#p" fill="#fff" filter="url(#f)"/><use xlink:href="#p" fill="#123"/>
<image width="4" height="4" href="data:image/png;base64,iVBORw0KGgo="/>
<text x="150" y="60" font-family="DejaVu Sans" font-size="20">Hi</text>
</svg>"""

SQUARE = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#E11D48"/></svg>'


class FakeMessage:
    """Records reply_document / reply_photo like PTB's Message would make them."""

    def __init__(self, chat_id=1, thread_id=None):
        self.chat_id = chat_id
        self.message_thread_id = thread_id
        self.is_topic_message = thread_id is not None
        self.calls = []

    def _record(self, kind, data, filename, caption):
        raw = data if isinstance(data, (bytes, bytearray)) else data.read()
        self.calls.append(
            {
                "kind": kind,
                "chat_id": self.chat_id,
                "thread": self.message_thread_id,
                "filename": filename,
                "caption": caption,
                "bytes": bytes(raw),
            }
        )
        return SimpleNamespace(message_id=1)

    async def reply_document(self, document, filename, caption=None, **kw):
        return self._record("document", document, filename, caption)

    async def reply_photo(self, photo, filename=None, caption=None, **kw):
        return self._record("photo", photo, filename, caption)


@pytest.fixture
def vault(tmp_path):
    root = tmp_path / "vault"
    (root / "drawings").mkdir(parents=True)
    return root


def sender(vault, drawing=True, msg=None, **kw):
    return ReplyFileSender(
        message=msg or FakeMessage(),
        policy=FileSendPolicy(root=vault, **kw),
        cwd=vault,
        drawing=DrawPolicy() if drawing is True else (drawing or None),
    )


def put(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


async def call(server_cfg, name, args):
    """Through the Agent SDK's own MCP router, as the CLI's request would go."""
    q = Query.__new__(Query)
    q.sdk_mcp_servers = {server_cfg["name"]: server_cfg["instance"]}
    resp = await q._handle_sdk_mcp_request(
        server_cfg["name"],
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        },
    )
    return resp["result"]


async def list_tools(server_cfg):
    q = Query.__new__(Query)
    q.sdk_mcp_servers = {server_cfg["name"]: server_cfg["instance"]}
    resp = await q._handle_sdk_mcp_request(
        server_cfg["name"], {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    )
    return resp["result"]["tools"]


def settings_for(root, **kw):
    return Settings(
        telegram_bot_token="test:token",
        telegram_bot_username="testbot",
        approved_directory=root,
        enable_mcp=False,
        **kw,
    )


# ------------------------------------------------------------------ checks --


class TestCheckSvg:
    def test_a_real_drawing_passes_and_reports_its_size(self):
        info = check_svg(GOOD)
        assert (info.width, info.height) == (200, 100)

    def test_size_falls_back_to_width_height_then_square(self):
        w = b'<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="150"/>'
        assert check_svg(w).aspect == 2
        assert check_svg(b'<svg xmlns="http://www.w3.org/2000/svg"/>').aspect == 1

    @pytest.mark.parametrize(
        "svg, why",
        [
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                "script",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
                "foreignobject",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
                "Event handler",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()"/></svg>',
                "Event handler",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/passwd"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><image href="secret.png"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><use href="other.svg#x"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><a href="https://phish.example"><rect/></a></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://x/y)"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(\'https://x/y#g\')"/></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(x.css);</style></svg>',
                "@import",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(http://x)}</style></svg>',
                "outside",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>',
                "javascript",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="x"/></svg>',
                "Animating",
            ),
            (
                b'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
                "DOCTYPE",
            ),
            (
                b'<?xml-stylesheet href="x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
                "stylesheet",
            ),
            (
                b'<svg xmlns="http://www.w3.org/2000/svg"><h:div xmlns:h="http://www.w3.org/1999/xhtml"/></svg>',
                "not allowed",
            ),
            (b"<html><svg/></html>", "not an SVG"),
            (b"<svg", "not well-formed"),
            (b"", "empty"),
            (b"\x1f\x8b\x08\x00", "svgz"),
            (b"\xff\xfe<\x00s\x00", "UTF-8"),
        ],
    )
    def test_refused(self, svg, why):
        with pytest.raises(DrawingError, match=f"(?i){why}"):
            check_svg(svg)

    def test_size_cap(self):
        big = b'<svg xmlns="http://www.w3.org/2000/svg">' + b" " * 5000 + b"</svg>"
        with pytest.raises(DrawingError, match="limit"):
            check_svg(big, max_bytes=4096)

    def test_element_cap(self):
        many = b'<svg xmlns="http://www.w3.org/2000/svg">' + b"<g/>" * 20001 + b"</svg>"
        with pytest.raises(DrawingError, match="elements"):
            check_svg(many, max_bytes=10**7)

    def test_backgrounds(self):
        assert parse_background(None) is None
        assert parse_background("transparent", "#fff") is None
        assert parse_background("dark") == "#0D1117"
        assert parse_background("#AbC") == "#abc"
        assert parse_background(None, "#FFFFFF") == "#FFFFFF"
        for bad in ("url(x)", "#12", "red;x", "a" * 30):
            with pytest.raises(DrawingError):
                parse_background(bad)

    def test_fit_keeps_proportions(self):
        assert fit(check_svg(GOOD), 1000) == (1000, 500)
        tall = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 100"/>'
        assert fit(check_svg(tall), 1000) == (500, 1000)


# --------------------------------------------------------------- rendering --


@needs_renderer
class TestRender:
    async def test_render_saves_png_and_returns_the_picture_to_claude(self, vault):
        put(vault / "drawings" / "logo-v1.svg", GOOD)
        s = sender(vault)
        server = build_file_tool_server(s)
        res = await call(
            server, RENDER_TOOL_NAME, {"path": "drawings/logo-v1.svg", "size": 400}
        )
        assert not res.get("isError"), res
        kinds = [c["type"] for c in res["content"]]
        assert kinds == ["text", "image", "image"]
        assert "drawings/logo-v1.png" in res["content"][0]["text"]
        view = base64.b64decode(res["content"][1]["data"])
        strip = base64.b64decode(res["content"][2]["data"])
        assert res["content"][1]["mimeType"] == "image/png"
        assert png_size(view) == (400, 200)
        assert png_size(strip)[0] > 600  # four tiles
        saved = (vault / "drawings" / "logo-v1.png").read_bytes()
        assert png_size(saved) == (400, 200)
        assert (
            view != saved
        )  # Claude sees it over a checkerboard; the file stays transparent
        assert s.message.calls == []  # nothing went to the chat

    async def test_background_and_no_small_sizes(self, vault):
        put(vault / "a.svg", SQUARE)
        note, imgs = await sender(vault).render(
            "a.svg", size=128, background="dark", small_sizes=False
        )
        assert len(imgs) == 1 and png_size(imgs[0]) == (128, 128)
        assert imgs[0] == (vault / "a.png").read_bytes()
        assert "#0D1117" in note

    async def test_big_render_is_shown_to_claude_smaller(self, vault):
        put(vault / "a.svg", SQUARE)
        s = sender(vault)
        _note, imgs = await s.render("a.svg", size=2048, small_sizes=False)
        assert png_size((vault / "a.png").read_bytes()) == (2048, 2048)
        assert png_size(imgs[0]) == (1024, 1024)

    @pytest.mark.parametrize("size", [8, 5000, "big"])
    async def test_size_bounds(self, vault, size):
        put(vault / "a.svg", SQUARE)
        with pytest.raises(FileSendError, match="size"):
            await sender(vault).render("a.svg", size=size)

    async def test_unsafe_svg_is_not_rendered(self, vault):
        put(
            vault / "bad.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
        )
        res = await call(
            build_file_tool_server(sender(vault)), RENDER_TOOL_NAME, {"path": "bad.svg"}
        )
        assert res["isError"] and "Not rendered" in res["content"][0]["text"]
        assert not (vault / "bad.png").exists()

    async def test_only_svg_inside_the_folder(self, vault, tmp_path):
        put(tmp_path / "out.svg", SQUARE)
        put(vault / "x.png", b"\x89PNG\r\n\x1a\n")
        s = sender(vault)
        with pytest.raises(FileSendError, match="outside"):
            await s.render(str(tmp_path / "out.svg"))
        with pytest.raises(FileSendError, match="svg"):
            await s.render("x.png")

    async def test_render_cap_per_reply(self, vault):
        put(vault / "a.svg", SQUARE)
        s = sender(vault, drawing=DrawPolicy(max_renders=2))
        await s.render("a.svg", size=64, small_sizes=False)
        await s.render("a.svg", size=64, small_sizes=False)
        with pytest.raises(FileSendError, match="Already rendered 2"):
            await s.render("a.svg", size=64, small_sizes=False)

    async def test_renderer_error_is_reported(self, vault):
        put(vault / "a.svg", SQUARE)
        s = sender(vault, drawing=DrawPolicy(timeout=0.001))
        with pytest.raises(FileSendError, match="longer than"):
            await s.render("a.svg", size=64)

    async def test_contact_sheet(self, vault):
        for i, color in enumerate(["#E11D48", "#2563EB", "#16A34A", "#F59E0B"]):
            put(
                vault / "drawings" / f"m-s{i}-v1.svg",
                SQUARE.replace(b"#E11D48", color.encode()),
            )
        s = sender(vault)
        res = await call(
            build_file_tool_server(s),
            SHEET_TOOL_NAME,
            {
                "paths": [f"drawings/m-s{i}-v1.svg" for i in range(4)],
                "labels": ["a", "b", "c", "d"],
                "tile": 200,
            },
        )
        assert not res.get("isError"), res
        assert [c["type"] for c in res["content"]] == ["text", "image"]
        sheets = list((vault / "drawings").glob("*sheet*.png"))
        assert len(sheets) == 1
        w, h = png_size(sheets[0].read_bytes())
        assert w > 400 and h > 400  # 2 x 2
        assert "as_photo=true" in res["content"][0]["text"]
        assert s.message.calls == []

    async def test_contact_sheet_limits(self, vault, tmp_path):
        put(vault / "a.svg", SQUARE)
        put(vault / "r.docx", b"PK")
        s = sender(vault, drawing=DrawPolicy(max_renders=50))
        with pytest.raises(FileSendError, match="At most 12"):
            await s.contact_sheet(["a.svg"] * 13)
        with pytest.raises(FileSendError, match="one label per file"):
            await s.contact_sheet(["a.svg", "a.svg"], labels=["x"])
        with pytest.raises(FileSendError, match="takes .svg and .png"):
            await s.contact_sheet(["a.svg", "r.docx"])
        with pytest.raises(FileSendError, match="inside your folder"):
            await s.contact_sheet(["a.svg"], out=str(tmp_path / "x.png"))
        with pytest.raises(FileSendError, match=r"\.png"):
            await s.contact_sheet(["a.svg"], out="sheet.svg")


# ----------------------------------------------------------------- sending --


@needs_renderer
class TestSend:
    async def test_svg_goes_as_the_real_vector_file(self, vault):
        put(vault / "logo.svg", GOOD)
        msg = FakeMessage(5, thread_id=300)
        text = await sender(vault, msg=msg).send("logo.svg", "Logo")
        assert text.startswith("Sent logo.svg")
        assert [c["kind"] for c in msg.calls] == ["document"]
        assert msg.calls[0]["bytes"] == GOOD and msg.calls[0]["thread"] == 300

    async def test_svg_with_preview(self, vault):
        put(vault / "logo.svg", GOOD)
        msg = FakeMessage(5, thread_id=300)
        s = sender(vault, msg=msg)
        text = await s.send("logo.svg", "Logo", preview=True, background="dark")
        assert "PNG preview" in text
        assert [c["kind"] for c in msg.calls] == ["document", "photo"]
        photo = msg.calls[1]
        assert photo["filename"] == "logo.png" and png_size(photo["bytes"]) == (
            1024,
            512,
        )
        assert all(c["chat_id"] == 5 and c["thread"] == 300 for c in msg.calls)
        assert (vault / "logo.preview.png").read_bytes() == photo["bytes"]
        assert len(s.sent) == 2

    async def test_preview_counts_two_against_the_cap(self, vault):
        put(vault / "logo.svg", GOOD)
        s = sender(vault, max_files=2)
        await s.send("logo.svg", preview=True)
        with pytest.raises(FileSendError, match="Already sent 2"):
            await s.send("logo.svg")
        s2 = sender(vault, max_files=1)
        with pytest.raises(FileSendError, match="counts as two"):
            await s2.send("logo.svg", preview=True)
        assert s2.message.calls == []

    async def test_unsafe_svg_never_reaches_telegram(self, vault):
        put(
            vault / "x.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/shadow"/></svg>',
        )
        s = sender(vault)
        with pytest.raises(FileSendError, match="Not a safe SVG"):
            await s.send("x.svg")
        s_off = sender(vault, drawing=None)
        with pytest.raises(FileSendError, match="Not a safe SVG"):
            await s_off.send("x.svg")
        assert s.message.calls == [] and s_off.message.calls == []

    async def test_png_as_photo(self, vault):
        put(vault / "a.svg", SQUARE)
        s = sender(vault)
        await s.render("a.svg", size=256, small_sizes=False)
        await s.send("a.png", "pic", as_photo=True)
        assert [c["kind"] for c in s.message.calls] == ["photo"]
        assert png_size(s.message.calls[0]["bytes"]) == (256, 256)

    async def test_as_photo_needs_a_real_picture(self, vault):
        put(vault / "a.svg", SQUARE)
        put(vault / "fake.png", b"not a png at all")
        s = sender(vault)
        with pytest.raises(FileSendError, match="as_photo"):
            await s.send("a.svg", as_photo=True)
        with pytest.raises(FileSendError, match="as_photo"):
            await s.send("fake.png", as_photo=True)

    async def test_preview_and_photo_need_drawing_on(self, vault):
        put(vault / "a.svg", SQUARE)
        s = sender(vault, drawing=None)
        with pytest.raises(FileSendError, match="drawing switched on"):
            await s.send("a.svg", preview=True)
        await s.send("a.svg")  # plain SVG sending still works
        assert [c["kind"] for c in s.message.calls] == ["document"]

    @pytest.mark.parametrize("name", ["p.jpg", "p.jpeg", "p.webp", "p.svg"])
    async def test_new_types_are_sendable(self, vault, name):
        data = SQUARE if name.endswith(".svg") else b"\xff\xd8\xff\xe0 picture"
        put(vault / name, data)
        await sender(vault).send(name)


# ---------------------------------------------------------- tools & wiring --


class TestTools:
    async def test_tool_list_with_and_without_drawing(self, vault):
        on = await list_tools(build_file_tool_server(sender(vault)))
        off = await list_tools(build_file_tool_server(sender(vault, drawing=None)))
        assert [t["name"] for t in on] == [TOOL_NAME, RENDER_TOOL_NAME, SHEET_TOOL_NAME]
        assert [t["name"] for t in off] == [TOOL_NAME]
        send_on = on[0]["inputSchema"]["properties"]
        assert {"preview", "as_photo", "background"} <= set(send_on)
        assert "preview" not in off[0]["inputSchema"]["properties"]
        for t in on:  # still no way to pick a chat
            assert not {"chat_id", "chat", "thread_id", "topic"} & set(
                t["inputSchema"]["properties"]
            )

    async def test_render_tool_refused_when_drawing_off(self, vault):
        put(vault / "a.svg", SQUARE)
        res = await call(
            build_file_tool_server(sender(vault, drawing=None)),
            RENDER_TOOL_NAME,
            {"path": "a.svg"},
        )
        assert res["isError"] and "Unknown tool" in res["content"][0]["text"]

    def test_tool_names(self, vault):
        assert tool_names(sender(vault)) == [
            "mcp__joya_files__send_file",
            "mcp__joya_files__render_svg",
            "mcp__joya_files__contact_sheet",
        ]
        assert tool_names(sender(vault, drawing=None)) == ["mcp__joya_files__send_file"]

    def test_settings_defaults_and_bounds(self, vault):
        s = settings_for(vault)
        assert s.allow_drawing is True
        assert (s.draw_max_render_px, s.draw_max_renders_per_reply, s.svg_max_kb) == (
            2048,
            12,
            2048,
        )
        with pytest.raises(Exception):
            settings_for(vault, draw_max_render_px=10000)

    def test_drawing_follows_file_sending(self, vault):
        assert (
            make_reply_file_sender(
                settings_for(vault, allow_file_send=False), FakeMessage(), vault
            )
            is None
        )
        off = make_reply_file_sender(
            settings_for(vault, allow_drawing=False), FakeMessage(), vault
        )
        assert off is not None and off.drawing is None
        with patch("src.claude.drawing.renderer_available", return_value=False):
            missing = make_reply_file_sender(settings_for(vault), FakeMessage(), vault)
        assert missing.drawing is None
        if renderer_available():
            on = make_reply_file_sender(
                settings_for(vault, draw_max_render_px=1024), FakeMessage(), vault
            )
            assert on.drawing.max_render_px == 1024

    def test_guide(self, vault):
        text = drawing_guide(DrawPolicy())
        for needle in (
            "render_svg",
            "contact_sheet",
            "Checklist",
            "32 px",
            "Cookbook",
            "feTurbulence",
            "Arabic",
            "photo",
            "viewBox",
            "-v1.svg",
            "light",
            "dark",
        ):
            assert needle.lower() in text.lower(), needle
        assert "{max_px}" not in text and "{fonts}" not in text
        full = file_guide(settings_for(vault), DrawPolicy())
        assert "DRAWING PICTURES" in full and "SENDING FILES" in full
        assert "DRAWING PICTURES" not in file_guide(settings_for(vault))

    async def test_sdk_options_allow_the_drawing_tools(self, vault):
        from tests.unit.test_claude.test_file_send import _mock_client_factory

        captured = []
        mgr = ClaudeSDKManager(settings_for(vault))
        with (
            patch("src.claude.sdk_integration.parse_message", side_effect=lambda x: x),
            patch(
                "src.claude.sdk_integration.ClaudeSDKClient",
                side_effect=_mock_client_factory(captured),
            ),
        ):
            await mgr.execute_command(
                prompt="hi", working_directory=vault, file_sender=sender(vault)
            )
        opts = captured[0]
        assert opts.mcp_servers["joya_files"]["type"] == "sdk"
        assert "mcp__joya_files__render_svg" in opts.allowed_tools
        assert "mcp__joya_files__contact_sheet" in opts.allowed_tools
        assert "DRAWING PICTURES" in opts.system_prompt
