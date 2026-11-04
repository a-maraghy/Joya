"use strict";
/**
 * Pages for the JOYA AI desktop app (lib/desktop.js): its download page, and
 * the two browser pages of the sign-in hand-off ("link this computer's app",
 * then "back to the app"). Everything escaped; no inline script or style.
 */

const { esc, shell, card, icon } = require("./ui");

function size(n) {
  if (!(n > 0)) return "";
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

/** /desktop/: the installer, how to trust the certificate, what the app is. */
function download(o) {
  const off = o.offer;
  const inst = off && off.installer;
  const body =
    card(
      "JOYA AI for Windows",
      `<p>The Command Center without its page: the JOYA AI core, the sessions, the chat, the voice and the approval cards, straight on your Windows desktop. Floating in a corner (the default), hidden until you call it (Peek), or on the wallpaper (Desktop layer).</p>
      ${
        inst
          ? `<p class="btn-row"><a class="btn primary" href="/desktop/files/${encodeURIComponent(inst.name)}" download>${icon("external", 16)} Download ${esc(inst.name)}</a><span class="muted small">version ${esc(off.version)} · ${esc(size(inst.size))}${off.date ? " · " + esc(String(off.date).slice(0, 10)) : ""}</span></p>`
          : `<div class="alert info">${icon("info")}<div>No installer has been published here yet.</div></div>`
      }
      ${off && off.notes ? `<p class="muted small">${esc(off.notes)}</p>` : ""}`,
      { icon: "monitor", id: "dl" }
    ) +
    card(
      "Trust the installer (once per computer)",
      `<p>The installer is signed with Joya's own code-signing certificate, which Windows does not know yet. Until it is trusted, Windows SmartScreen says "Windows protected your PC".</p>
      <ol class="steps">
        <li>${off && off.cert ? `<a href="/desktop/files/${esc(off.cert)}" download>Download the certificate</a> (joya-desktop-codesign.cer)` : "Get the certificate (joya-desktop-codesign.cer) from your administrator"}.</li>
        <li>Open PowerShell <b>as administrator</b> in the folder it is in, and run:<br><code class="mono">Import-Certificate -FilePath .\\joya-desktop-codesign.cer -CertStoreLocation Cert:\\LocalMachine\\TrustedPublisher</code><br><code class="mono">Import-Certificate -FilePath .\\joya-desktop-codesign.cer -CertStoreLocation Cert:\\LocalMachine\\Root</code></li>
        <li>Check the installer is the one signed with it: right-click it, Properties, Digital Signatures: "Joya Desktop (self-signed)".</li>
        <li>Run the installer. JOYA AI starts floating at the bottom right; its icon is in the tray.</li>
      </ol>
      <p class="muted small">Only do this on your own computers. Updates arrive by themselves, signed with the same certificate and checked against the app's update key.</p>`,
      { icon: "shield", id: "trust" }
    ) +
    card(
      "Signing in",
      `<p>The app signs in like the site: your password, then Windows Hello. It stays signed in for <b>${esc(String(o.days))} days</b>, then asks again. If Windows Hello cannot show inside the app, its sign-in card offers <i>Sign in in your browser</i>: you sign in here, press Link, and the app is signed in.</p>`,
      { icon: "lock", id: "signin" }
    );
  return shell("Desktop app", body, { user: o.user, csrf: o.csrf, active: "desktop", heading: "JOYA AI for Windows" });
}

/** /desktop/link (browser): link the app on this computer to this account. */
function link(o) {
  const inner = o.error
    ? `<div class="alert bad">${icon("alert")}<div>${esc(o.error)}</div></div><p><a class="btn" href="/joya-ai">Go to the Command Center</a></p>`
    : o.stale
      ? `<p>To link the JOYA AI app, confirm it is you again: sign in once more in this browser (password, then Windows Hello).</p>
        <form method="post" action="/desktop/link/again"><input type="hidden" name="_csrf" value="${esc(o.csrf)}"><input type="hidden" name="c" value="${esc(o.challenge)}"><input type="hidden" name="p" value="${esc(String(o.port))}">
        <button class="btn primary w-full" type="submit">Sign in again</button></form>`
      : `<p>Sign the <b>JOYA AI desktop app</b> on this computer in as <b class="mono">${esc(o.username)}</b>?</p>
        <p class="muted small">Only press Link if you just pressed "Sign in in your browser" in the app yourself. The app stays signed in for ${esc(String(o.days))} days.</p>
        <form method="post" action="/desktop/link"><input type="hidden" name="_csrf" value="${esc(o.csrf)}"><input type="hidden" name="c" value="${esc(o.challenge)}"><input type="hidden" name="p" value="${esc(String(o.port))}">
        <button class="btn primary w-full" type="submit">${icon("check", 16)} Link the app</button></form>
        <p class="auth-foot">${icon("lock", 14)}<span>The link works once, for two minutes, and only for the app that asked.</span></p>`;
  return shell("Link the desktop app", `<div class="card"><h2 class="mb-14">JOYA AI desktop app</h2>${inner}</div>`, {});
}

/** After Link: the browser goes back to the app's loopback with the code (public/joya-desktop-link.js). */
function linked(o) {
  return shell(
    "Back to the app",
    `<div class="card" id="dk-linked" data-to="${esc(o.to)}"><h2 class="mb-14">Back to JOYA AI</h2>
      <p>The app on this computer is being signed in. You can close this tab.</p>
      <p><a class="btn primary" href="${esc(o.to)}" id="dk-linked-go">Finish in the app</a></p></div>`,
    { assets: ["joya-desktop-link.js"] }
  );
}

module.exports = { download, link, linked };
