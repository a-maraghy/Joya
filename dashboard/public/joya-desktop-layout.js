"use strict";
/*
 * The JOYA AI desktop app's layouts (Floating, Peek, Desktop layer), as one
 * pure function, shared by the page (public/joya-desktop.js) and the tests
 * (tools/test-desktop-shell.cjs). The numbers are the approved mockup's
 * (mockups/desktop-app, L() and layoutChrome()).
 *
 * The app's window is not the screen: in Floating it is the box (480 x 580 at
 * size M) with HEADROOM above it for a decision card, so the card grows above
 * the box and never covers its own core; in Peek and Desktop layer it is the
 * monitor's work area. So every number here is in the window's own CSS
 * pixels, (0, 0) at its top left.
 *
 *   JoyaDesktopLayout.layout({ mode, size, pos, focus, W, H, glance, pin }) ->
 *     { mode, box, cx, cy, R, chatBtn, liveBtn, glanceBtn, panel, caption, card, gate, tools, glance }
 *
 * glance (0.1.9): the glance cards' column ({ x, y, w, h, align, pinned, side }, or null when the
 * cards are off, in focus mode, or the Floating window was not widened for them). In Floating the
 * window is GL_W + GL_GAP wider and the box sits at the screen-edge end of it; in the Desktop layer
 * and Peek the column is beside the core, or where it was pinned (pin: fractions of the window).
 *
 * Since 0.1.2 nothing of the conversation shows by itself: the core, the
 * session spheres and the state pill; a small round chat button on the core's
 * lower right (chatBtn: its centre and diameter) opens the chat panel (panel:
 * the recent conversation with the composer inside), under the core.
 *   JoyaDesktopLayout.windowSize({ mode, size, focus }) -> { w, h } (Floating only)
 *
 * The host (desktop/src-tauri/src/layout.rs) sizes the Floating window with
 * the same numbers; tools/test-desktop-shell.cjs checks they agree.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JoyaDesktopLayout = api;
})(typeof self !== "undefined" ? self : this, function () {
  var SIZES = { S: 0.8, M: 1, L: 1.22 };
  var MODES = { desktop: 1, floating: 1, peek: 1 };
  var HEADROOM = 280; // above the Floating box: where its decision card goes
  var MARGIN = 14;
  var BTN = 34; // the chat button's diameter
  var PANEL_MAX_H = 440;
  // The glance cards (approvals, sessions, today's tokens, alerts) beside the core: a column this wide,
  // this far from the Floating box. Not scaled with S/M/L (they are text). layout.rs has the same numbers.
  var GL_W = 256;
  var GL_GAP = 12;

  /*
   * The core's two round buttons, on its rim at the lower right: chat at 10
   * degrees below the horizontal (about 3 o'clock), the live call at 42 (about
   * half past 4) -- clear of each other and of the state pill under the core
   * at every size.
   */
  function rimBtn(L, deg) {
    var D = L.R * 1.02 + 8, a = (deg * Math.PI) / 180;
    return { x: L.cx + D * Math.cos(a), y: L.cy + D * Math.sin(a), d: BTN };
  }
  function chatBtn(L) { return rimBtn(L, 10); }
  function liveBtn(L) { return rimBtn(L, 42); }
  // The glance cards' show / hide button: upper right of the rim (about 2 o'clock), clear of the tools.
  function glanceBtn(L) { return rimBtn(L, -24); }

  function sizeK(s) { return SIZES[s] || 1; }
  function mode(m) { return MODES[m] ? m : "floating"; }

  /**
   * The Floating window: the box, plus the headroom above it (none in focus mode: no card shows),
   * plus the glance column beside it when the cards are shown (o.glance; never in focus mode).
   */
  function windowSize(o) {
    o = o || {};
    var k = sizeK(o.size);
    var bw = Math.round((o.focus ? 168 : 480) * k), bh = Math.round((o.focus ? 168 : 580) * k);
    var gl = o.glance && !o.focus ? GL_W + GL_GAP : 0;
    return { w: bw + gl, h: bh + (o.focus ? 0 : HEADROOM), box: { w: bw, h: bh } };
  }
  /** A Floating corner on the right of the screen (the default, "br"): the box at the window's right end, the cards to its left. */
  function rightCorner(pos) { return !/l$/.test(pos || ""); }

  function layout(o) {
    o = o || {};
    var m = mode(o.mode), k = sizeK(o.size), W = Math.max(1, o.W || 1), H = Math.max(1, o.H || 1);
    var focus = !!o.focus;
    var L = { mode: m, focus: focus, W: W, H: H };
    if (m === "floating") {
      // A bottom corner (the default): the box at the bottom of the window, the card's headroom above it.
      // A top corner: the box at the top, the headroom below (the app places the window the same way).
      var up = /^t/.test(o.pos || "");
      var ws = windowSize(o), bw = ws.box.w, bh = ws.box.h, top = up ? 0 : H - bh;
      // The glance column beside the box, on the side away from the screen's edge -- only when the window
      // was made wide enough for it (the app sizes it with the same numbers).
      var gl = !!o.glance && !focus && W >= bw + GL_GAP + GL_W - 0.5, right = rightCorner(o.pos);
      var bx = gl && right ? W - bw : 0;
      L.box = { x: bx, y: top, w: bw, h: bh };
      L.cx = bx + bw / 2;
      L.cy = focus ? top + bh / 2 : top + bh * 0.36;
      L.R = focus ? bw * 0.3 : bw * 0.163;
      L.caption = { x: L.cx, y: L.cy + L.R + 6 };
      L.chatBtn = chatBtn(L);
      L.liveBtn = liveBtn(L);
      L.glanceBtn = focus ? null : glanceBtn(L);
      // The chat panel: the box's lower part, under the state pill.
      var pTop = L.cy + L.R + 40;
      L.panel = { x: bx + MARGIN, y: pTop, w: bw - 2 * MARGIN, h: Math.max(120, top + bh - MARGIN - pTop) };
      // The card: in the headroom, 10 px off the box, right-aligned; never over the core.
      var cw = Math.min(330, bw - 16);
      L.card = up ? { x: bx + Math.max(8, bw - cw - 8), y: bh + 10, w: cw, h: Math.max(0, H - bh - 18), bottom: null } : { x: bx + Math.max(8, bw - cw - 8), y: 8, w: cw, h: Math.max(0, top - 18), bottom: H - top + 10 };
      L.gate = { x: bx + bw / 2, y: top + bh - 170, w: Math.min(340, bw - 20) };
      L.tools = { x: bx + bw - 136, y: top + 8 };
      // The cards: the whole height of the window beside the box (the headroom too), stacked from the
      // box's end of it: up from the bottom in a bottom corner, down from the top in a top corner.
      L.glance = gl ? { x: right ? 0 : bw + GL_GAP, y: 8, w: GL_W, h: H - 16, align: up ? "start" : "end", pinned: false, side: right ? "left" : "right" } : null;
      return L;
    }
    var R = (m === "peek" ? 180 : 170) * k;
    var fx = m === "peek" ? 0.5 : { left: 0.36, centre: 0.5, right: 0.56 }[o.pos || "right"] || 0.56;
    L.box = { x: 0, y: 0, w: W, h: H };
    L.cx = W * fx;
    L.cy = H * (m === "peek" ? 0.4 : 0.42);
    L.R = R;
    // Small screens: the core leaves room under it for the state pill and the chat panel's top.
    if (L.cy + L.R + 60 > H - 72) L.R = Math.max(60, H - 72 - 60 - L.cy);
    L.caption = { x: L.cx, y: L.cy + L.R + 16 };
    L.chatBtn = chatBtn(L);
    L.liveBtn = liveBtn(L);
    // The chat panel: under the core, centred on it; where there is no room under it, beside it.
    var pw = Math.min(m === "peek" ? 560 : 460, W - 32);
    var py = L.cy + L.R + 56, ph = Math.min(PANEL_MAX_H, H - 24 - py);
    if (ph >= 220) L.panel = { x: Math.max(16, Math.min(W - 16 - pw, L.cx - pw / 2)), y: py, w: pw, h: ph };
    else {
      ph = Math.min(PANEL_MAX_H, H - 32);
      var right = W - 16 - (L.cx + L.R + 32) >= L.cx - L.R - 32 - 16; // the wider side
      pw = Math.max(260, Math.min(pw, right ? W - 16 - (L.cx + L.R + 32) : L.cx - L.R - 48));
      L.panel = { x: right ? Math.min(W - 16 - pw, L.cx + L.R + 32) : Math.max(16, L.cx - L.R - 32 - pw), y: Math.max(16, Math.min(H - 16 - ph, L.cy - ph / 2)), w: pw, h: ph };
    }
    L.card = { x: Math.max(16, W - 16 - 330), y: 72, w: Math.min(330, W - 32), h: H - 72 - 16, bottom: null };
    L.gate = { x: L.cx, y: L.cy + L.R + 60, w: 340 };
    L.tools = null;
    L.glanceBtn = focus ? null : glanceBtn(L);
    L.glance = focus || !o.glance ? null : glanceSlot(L, o.pin);
    return L;
  }

  /**
   * Desktop layer and Peek: where the glance column goes. Pinned (o.pin: { x, y } as fractions of the
   * window, i.e. of the monitor's work area, remembered per monitor by the app): there, kept on screen.
   * Otherwise beside the core, on the side with more room (the left when the core is right of centre,
   * so it never meets the decision card at the top right), clear of the core and the chat panel,
   * starting level with the core's top.
   */
  function glanceSlot(L, pin) {
    var W = L.W, H = L.H, w = Math.min(GL_W, W - 16);
    if (pin && isFinite(pin.x) && isFinite(pin.y)) {
      var px = Math.max(8, Math.min(W - w - 8, pin.x * W)), py = Math.max(8, Math.min(H - 140, pin.y * H));
      return { x: px, y: py, w: w, h: Math.max(120, H - py - 16), align: "start", pinned: true, side: px + w / 2 < L.cx ? "left" : "right" };
    }
    var p = L.panel, beside = p.y < L.cy + L.R; // the chat panel went beside the core (no room under it)
    var gap = 40;
    var leftEnd = L.cx - L.R - gap, rightStart = L.cx + L.R + gap;
    if (!beside) { leftEnd = Math.min(leftEnd, p.x - 16); rightStart = Math.max(rightStart, p.x + p.w + 16); }
    // (A small screen puts the chat panel beside the core too: then the cards may share its side -- they
    // step aside while the panel is open, joya-desktop.js -- rather than meet the decision card.)
    var side = W - L.cx > L.cx ? "right" : "left";
    var x = side === "left" ? leftEnd - w : rightStart;
    // No room on that side: the other one, else as near as fits.
    if (side === "left" && x < 16 && rightStart + w <= W - 16) { side = "right"; x = rightStart; }
    else if (side === "right" && x + w > W - 16 && leftEnd - w >= 16) { side = "left"; x = leftEnd - w; }
    x = Math.max(16, Math.min(W - 16 - w, x));
    var y = Math.max(16, L.cy - L.R);
    return { x: x, y: y, w: w, h: Math.max(120, H - y - 16), align: "start", pinned: false, side: side };
  }

  /**
   * The rectangles that catch the mouse, for the host's click-through: a list
   * of { x, y, w, h, r } (r: corner radius; a circle is w = h = 2r).
   * `els` are rects already measured (DOMRect-like); the core is a circle.
   * Anything zero-sized or wholly outside the window is dropped; the rest are
   * clipped to it and rounded outward to whole pixels.
   */
  function regions(L, els, opts) {
    opts = opts || {};
    var out = [];
    function add(x, y, w, h, r) {
      var x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      var x1 = Math.min(L.W, Math.ceil(x + w)), y1 = Math.min(L.H, Math.ceil(y + h));
      if (x1 - x0 < 1 || y1 - y0 < 1) return;
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.max(0, Math.round(r || 0)) });
    }
    if (opts.all) { add(0, 0, L.W, L.H, 0); return out; }
    if (L.R > 0) add(L.cx - L.R, L.cy - L.R, 2 * L.R, 2 * L.R, L.R);
    (els || []).forEach(function (e) {
      if (!e || !(e.width > 0) || !(e.height > 0)) return;
      add(e.left != null ? e.left : e.x, e.top != null ? e.top : e.y, e.width, e.height, e.r || 0);
    });
    return out;
  }

  /**
   * Real blur (the app's acrylic windows, desktop/src-tauri/src/blur.rs): which glass surfaces to
   * report. A surface is reported only once it holds still -- the same rectangle on two measurements
   * at least GLASS_SETTLE_MS apart -- so a card sliding in or a menu fading never has a native window
   * chasing it; one that goes away (or starts to move) is dropped at once, so no blur outlives its card.
   *   glass(prev, items, now) -> { state, rects: [{ x, y, w, h, r }], keys: [key, …] }
   * prev: the last call's state (or null); items: [{ key, x, y, w, h, r }] measured now (CSS px).
   */
  var GLASS_SETTLE_MS = 80;
  function glass(prev, items, now) {
    var seen = (prev && prev.seen) || {};
    var next = {}, rects = [], keys = [];
    function q(v) { return Math.round(v * 2) / 2; }
    (items || []).forEach(function (it) {
      if (!it || it.key == null || !(it.w > 0) || !(it.h > 0)) return;
      var sig = [q(it.x), q(it.y), q(it.w), q(it.h), q(it.r || 0)].join(",");
      var was = seen[it.key];
      var since = was && was.sig === sig ? was.since : now;
      next[it.key] = { sig: sig, since: since };
      if (now - since >= GLASS_SETTLE_MS) {
        rects.push({ x: q(it.x), y: q(it.y), w: q(it.w), h: q(it.h), r: Math.max(0, Math.min(q(it.r || 0), q(it.w) / 2, q(it.h) / 2)) });
        keys.push(it.key);
      }
    });
    return { state: { seen: next }, rects: rects, keys: keys };
  }

  return { layout: layout, windowSize: windowSize, regions: regions, glass: glass, GLASS_SETTLE_MS: GLASS_SETTLE_MS, SIZES: SIZES, HEADROOM: HEADROOM, GL_W: GL_W, GL_GAP: GL_GAP };
});
