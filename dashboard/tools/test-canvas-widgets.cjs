#!/usr/bin/env node
"use strict";
/**
 * The living canvas's building blocks (public/joya-widgets.js): the schema and its validator, the catalog
 * JOYA AI reads, the supervisor's copy (joya-ai/lib/joya-widgets.js, the same file), the protocol's
 * ui-widget op and the MCP tools ui_widgets_list / ui_widget.
 *
 *     node dashboard/tools/test-canvas-widgets.cjs
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..");
const W = require(path.join(ROOT, "public", "joya-widgets.js"));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : "")); }
}
const section = (t) => console.log("\n" + t);
const SID = "bbbbbbbb-0000-4000-8000-000000000001", SID2 = "bbbbbbbb-0000-4000-8000-000000000002";
const ok = (w) => W.validate(w);

section("good widgets, made canonical");
{
  for (const e of W.catalog().examples) check("the catalog's example '" + e.title + "' is valid", ok(e).ok, JSON.stringify(ok(e)));
  const r = ok({ v: 1, kind: "metric", title: "  Disk  ", blocks: [{ type: "metric", label: "Used", value: 81.234567891, unit: "pct" }] });
  check("defaults filled (size m), text trimmed, numbers rounded to 6 places", r.ok && r.value.size === "m" && r.value.title === "Disk" && r.value.blocks[0].value === 81.234568 && r.value.blocks[0].tone === "" && r.value.blocks[0].hint === "", JSON.stringify(r));
  check("  its learning key: kind and where the data comes from", r.key === "metric:payload");
  check("a source's key: chart:usage.spend", ok({ v: 1, kind: "chart", title: "x", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days" }] }).key === "chart:usage.spend");
  check("a story block's key: story:story; an approval's: approval:approvals", ok({ v: 1, kind: "story", title: "x", blocks: [{ type: "story", session: SID }] }).key === "story:story" && ok({ v: 1, kind: "approval", title: "x", blocks: [{ type: "approval", approval: 7 }] }).key === "approval:approvals");
  const all = ok({
    v: 1, kind: "table", title: "Everything", note: "A note.", size: "l", blocks: [
      { type: "table", columns: [{ key: "a", label: "A" }, { key: "b_2", label: "B", align: "right", format: "usd" }], rows: [{ a: "x", b_2: 3.5 }, { a: "y" }] },
      { type: "text", text: "Line one\nline two", tone: "warn" },
      { type: "list", items: [{ text: "One", sub: "sub", tone: "ok", session: SID }, { text: "Two" }] },
      { type: "files", files: [{ path: "/root/joya/a.js", add: 12, del: 3 }] },
      { type: "chart", style: "line", unit: "tokens", series: [{ label: "t", points: [["10-01", 1], ["10-02", 2.5]] }] },
      { type: "compare", sessions: [SID, SID2] },
    ],
  });
  check("every payload block type in one table widget (6 blocks)", all.ok && all.value.blocks.length === 6 && all.value.blocks[0].rows[1].b_2 === "", JSON.stringify(all).slice(0, 300));
  check("sessions param: state defaults to any", ok({ v: 1, kind: "list", title: "x", source: { name: "sessions" }, blocks: [{ type: "list", view: "list" }] }).value.source.params.state === "any");
  check("story source needs its session", !ok({ v: 1, kind: "list", title: "x", source: { name: "story" }, blocks: [{ type: "list", view: "steps" }] }).ok && ok({ v: 1, kind: "files", title: "x", source: { name: "story", params: { session: SID } }, blocks: [{ type: "files", view: "files" }] }).ok);
}

section("refused: markup, scripts, URLs, unknown fields, wrong shapes");
{
  const base = () => ({ v: 1, kind: "list", title: "x", blocks: [{ type: "list", items: [{ text: "ok" }] }] });
  const with_ = (f) => { const w = base(); f(w); return w; };
  const cases = [
    ["an html field", with_((w) => (w.html = "<b>x</b>"))],
    ["markup in a title", with_((w) => (w.title = "<img src=x onerror=alert(1)>"))],
    ["markup in an item", with_((w) => (w.blocks[0].items[0].text = "click <a href='x'>here</a>"))],
    ["a script tag in text", { v: 1, kind: "list", title: "x", blocks: [{ type: "list", items: [{ text: "x" }] }, { type: "text", text: "<script>alert(1)</script>" }] }],
    ["an https URL", with_((w) => (w.blocks[0].items[0].text = "see https://evil.example/x"))],
    ["a javascript: link", with_((w) => (w.note = "javascript:alert(1)"))],
    ["a data: URI", with_((w) => (w.title = "data:text/html;base64,AAAA"))],
    ["a file:/ path as a URL", with_((w) => (w.title = "file:///etc/passwd"))],
    ["a url field on a block", with_((w) => (w.blocks[0].url = "/admin"))],
    ["a style field", with_((w) => (w.style = "color:red"))],
    ["an onclick on an item", with_((w) => (w.blocks[0].items[0].onclick = "x()"))],
    ["an action on an approval", { v: 1, kind: "approval", title: "x", blocks: [{ type: "approval", approval: 3, action: "approve" }] }],
    ["approval text from the payload", { v: 1, kind: "approval", title: "x", blocks: [{ type: "approval", approval: 3, summary: "harmless" }] }],
    ["an unknown block type (html)", { v: 1, kind: "list", title: "x", blocks: [{ type: "html", html: "x" }] }],
    ["an unknown kind", { v: 1, kind: "iframe", title: "x", blocks: [{ type: "text", text: "x" }] }],
    ["v 2 (not this catalog)", with_((w) => (w.v = 2))],
    ["no v", with_((w) => delete w.v)],
    ["no title", with_((w) => delete w.title)],
    ["a title of 81 characters", with_((w) => (w.title = "x".repeat(81)))],
    ["a control character", with_((w) => (w.title = "a\u0007b"))],
    ["no blocks", with_((w) => (w.blocks = []))],
    ["seven blocks", with_((w) => (w.blocks = Array(7).fill({ type: "text", text: "x" })))],
    ["a kind whose first block does not fit (chart starting with text)", { v: 1, kind: "chart", title: "x", blocks: [{ type: "text", text: "x" }] }],
    ["21 list items", with_((w) => (w.blocks[0].items = Array(21).fill({ text: "x" })))],
    ["51 table rows", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: [{ key: "a", label: "A" }], rows: Array(51).fill({ a: 1 }) }] }],
    ["9 columns", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: Array.from({ length: 9 }, (_, i) => ({ key: "c" + i, label: "C" })), rows: [] }] }],
    ["a cell for a column that does not exist", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: 1, b: 2 }] }] }],
    ["two columns with one key", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: [{ key: "a", label: "A" }, { key: "a", label: "B" }], rows: [] }] }],
    ["a bad column key", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: [{ key: "A-1", label: "A" }], rows: [] }] }],
    ["61 chart points", { v: 1, kind: "chart", title: "x", blocks: [{ type: "chart", series: [{ label: "s", points: Array(61).fill(["a", 1]) }] }] }],
    ["a NaN point", { v: 1, kind: "chart", title: "x", blocks: [{ type: "chart", series: [{ label: "s", points: [["a", NaN]] }] }] }],
    ["an Infinity value", { v: 1, kind: "metric", title: "x", blocks: [{ type: "metric", label: "l", value: Infinity }] }],
    ["a negative file count", { v: 1, kind: "files", title: "x", blocks: [{ type: "files", files: [{ path: "a", add: -1, del: 0 }] }] }],
    ["a story without a uuid", { v: 1, kind: "story", title: "x", blocks: [{ type: "story", session: "Planning engine" }] }],
    ["compare of one session twice", { v: 1, kind: "compare", title: "x", blocks: [{ type: "compare", sessions: [SID, SID] }] }],
    ["two approval blocks", { v: 1, kind: "approval", title: "x", blocks: [{ type: "approval", approval: 1 }, { type: "approval", approval: 2 }] }],
    ["an approval id 0", { v: 1, kind: "approval", title: "x", blocks: [{ type: "approval", approval: 0 }] }],
    ["a view with no source", { v: 1, kind: "chart", title: "x", blocks: [{ type: "chart", view: "days" }] }],
    ["a view of another type (usage.spend.today is a metric)", { v: 1, kind: "chart", title: "x", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "today" }] }],
    ["an unknown view", { v: 1, kind: "chart", title: "x", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "all" }] }],
    ["an unknown source (a url)", { v: 1, kind: "chart", title: "x", source: { name: "https://x" }, blocks: [{ type: "chart", series: [{ label: "s", points: [["a", 1]] }] }] }],
    ["an unknown source param", { v: 1, kind: "chart", title: "x", source: { name: "usage.spend", params: { url: "/x" } }, blocks: [{ type: "chart", view: "days" }] }],
    ["a view with data too", { v: 1, kind: "chart", title: "x", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days", series: [] }] }],
    ["larger than 12000 bytes", { v: 1, kind: "table", title: "x", blocks: [{ type: "table", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: Array(50).fill({ a: "y".repeat(119), b: "z".repeat(119) }) }] }],
    ["an array", []],
    ["a string", "{\"v\":1}"],
    ["null", null],
  ];
  for (const [what, w] of cases) {
    const r = ok(w);
    check("refused: " + what, !r.ok && typeof r.why === "string" && r.why.length > 5, JSON.stringify(r));
  }
  const why = ok({ v: 1, kind: "list", title: "x", blocks: [{ type: "list", items: [{ text: "ok", link: "x" }] }] }).why;
  check("the reason names where (path) and what is allowed", /widget\.blocks\[0\]\.items\[0\]/.test(why) && /unknown field "link"/.test(why) && /text, sub, tone, session/.test(why), why);
  const ws = "x".repeat(10);
  check("not a URL: 'Data: loaded', 'profile: x', a path, 'a < 5'", ok({ v: 1, kind: "list", title: "Data: loaded", blocks: [{ type: "list", items: [{ text: "profile: " + ws }, { text: "/var/lib/odoo" }, { text: "a < 5 and b > 2" }, { text: "a < b && c > d" }] }] }).ok);
}

section("the catalog JOYA AI reads");
{
  const c = W.catalog();
  check("version, kinds, blocks, sources with views, limits, rules, examples", c.version === 1 && Object.keys(c.kinds).length === 8 && Object.keys(c.blocks).length === 9 && Object.keys(c.sources).join() === "usage.spend,usage.caps,sessions,story,feed,approvals" && c.rules.length >= 5 && c.examples.length >= 3);
  check("the eight kinds the design asked for", ["chart", "files", "table", "approval", "compare", "story", "metric", "list"].every((k) => c.kinds[k]));
  check("every source view names a real block type", Object.values(W.SOURCES).every((s) => Object.values(s.views).every((v) => W.BLOCKS[v.block] && W.BLOCKS[v.block].view)));
  check("no field or source in the catalog takes a URL", !/\burl\b/i.test(JSON.stringify(c.blocks)) && Object.values(W.SOURCES).every((s) => !Object.keys(s.params).some((k) => /url|href|link/i.test(k))));
  check("plain JSON (what the MCP tool returns)", JSON.parse(JSON.stringify(c)).version === 1);
}

section("one file, three places");
{
  const a = fs.readFileSync(path.join(ROOT, "public", "joya-widgets.js"), "utf8");
  const b = fs.readFileSync(path.join(REPO, "joya-ai", "lib", "joya-widgets.js"), "utf8");
  check("joya-ai/lib/joya-widgets.js is byte-for-byte the dashboard's public/joya-widgets.js", a === b);
  const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("server.js: a widget event is delivered by uiWidgetDeliver, which offers it through routes-canvas (validated again there)", /if \(ev\.action === "widget\.show"\) return uiWidgetDeliver\(ev, req, res, ack\);/.test(srv) && /const o = canvas\.offer\(req\.me, ev\.widget\);/.test(srv) && /widget: o\.value/.test(srv));
  check("  the person's switch for screen actions applies to widgets too", /function uiWidgetDeliver[\s\S]{0,300}uiActionsEnabled\(db, req\.me\.id\)/.test(srv));
  const page = fs.readFileSync(path.join(ROOT, "public", "joya-canvas.js"), "utf8");
  check("the page validates again before drawing (JoyaCanvas.offer -> MW.validate)", /function offer\(ev\) \{\s*var v = MW\.validate\(ev && ev\.widget\);/.test(page));
  check("the page never parses a widget as markup (no innerHTML, insertAdjacentHTML, outerHTML, eval, Function)", !/innerHTML|insertAdjacentHTML|outerHTML|\beval\(|new Function/.test(page));
  check("  and builds no link or image from it (no href, src, location)", !/\.href\b|\.src\b|setAttribute\("(href|src)"|location\./.test(page));
  const mon = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("joya-ai.js hands widget.show to JoyaCanvas and acks it", /if \(ev\.action === "widget\.show"\) \{[\s\S]{0,200}window\.JoyaCanvas\.offer\(ev\)[\s\S]{0,200}api\("ui\/ack"/.test(mon));
}

section("the protocol: ui-widget");
{
  const proto = require(path.join(REPO, "joya-ai", "lib", "protocol.js"));
  const line = (o) => JSON.stringify(Object.assign({ id: "r1", actor: "joya-ai" }, o));
  const good = { v: 1, kind: "metric", title: "Disk", blocks: [{ type: "metric", label: "Used", value: 81 }] };
  const r = proto.parseRequest(line({ op: "ui-widget", widget: good }));
  check("ui-widget with a widget parses, canonical, mutating", r.ok && r.req.params.widget.size === "m" && r.req.mutating, JSON.stringify(r));
  const bad = proto.parseRequest(line({ op: "ui-widget", widget: { v: 1, kind: "text", title: "<b>x</b>", blocks: [] } }));
  check("a bad widget is refused at the socket, with the validator's reason", !bad.ok && /widget: widget\.kind/.test(bad.error), JSON.stringify(bad));
  check("no widget: refused", !proto.parseRequest(line({ op: "ui-widget" })).ok);
  check("an extra param: refused", !proto.parseRequest(line({ op: "ui-widget", widget: good, url: "x" })).ok);
}

section("the MCP tools");
{
  const mcp = require(path.join(REPO, "joya-ai", "bin", "joya-ai-mcp"));
  const list = mcp.TOOLS.find((t) => t.name === "ui_widgets_list"), tool = mcp.TOOLS.find((t) => t.name === "ui_widget");
  check("ui_widgets_list (read-only, local) and ui_widget (op ui-widget) exist", list && list.local && list.noArgs && tool && tool.op === "ui-widget");
  check("ui_widgets_list returns the catalog", JSON.stringify(list.local({})) === JSON.stringify(W.catalog()));
  const FROZEN = { type: "object", properties: { widget: { type: "object", description: "The widget: {v, kind, title, note?, source?, size?, blocks} as ui_widgets_list describes." } }, required: ["widget"], additionalProperties: false };
  check("ui_widget's schema is one object field, frozen (no enum): new blocks never change it", JSON.stringify(tool.inputSchema) === JSON.stringify(FROZEN) && !/enum/.test(JSON.stringify(tool.inputSchema)));
  let e1 = null;
  try { tool.map({ widget: { v: 1, kind: "metric", title: "x", blocks: [{ type: "metric", label: "l", value: 1 }] }, url: "x" }); } catch (e) { e1 = e.message; }
  check("ui_widget refuses another argument", /takes only widget/.test(e1 || ""), e1);
  let e2 = null;
  try { tool.map({ widget: { v: 1, kind: "metric", title: "<i>x</i>", blocks: [] } }); } catch (e) { e2 = e.message; }
  check("ui_widget refuses a bad widget before it reaches the socket, saying why", /not a widget: .*markup/.test(e2 || ""), e2);
  check("the server's instructions mention ui_widgets_list / ui_widget", /ui_widgets_list \/ ui_widget/.test(fs.readFileSync(path.join(REPO, "joya-ai", "bin", "joya-ai-mcp"), "utf8")));
  check("JOYA AI's charter says when to use it", /`ui_widget`/.test(fs.readFileSync(path.join(REPO, "joya-ai", "home", "CLAUDE.md"), "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
