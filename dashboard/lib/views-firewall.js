"use strict";
/**
 * The firewall page.
 *
 * Two systems decide who reaches this machine, and an operator asking "why can
 * this address not connect" should not have to know which one to ask. ufw holds
 * the standing rules; fail2ban watches the logs and writes temporary ones of its
 * own. This page merges them into a single list of blocked addresses, says which
 * system placed each one, and offers the same button either way — the helper
 * works out which system has to be told.
 */

const { esc, shell, card, flashes, empty, icon, stat, duration } = require("./ui");

/** Where a ban came from, as a badge. */
function sourcePill(entry) {
  return entry.jail
    ? `<span class="pill warn">${esc(entry.jail)}</span>`
    : `<span class="pill neutral">manual</span>`;
}

function expiry(entry) {
  if (!entry.jail) return `<span class="muted">until removed</span>`;
  if (entry.seconds != null && entry.seconds < 0)
    return `<span class="muted">until removed</span>`;
  return entry.until ? `<span class="mono small">${esc(entry.until)}</span>` : "—";
}

function unbanButton(csrf, entry) {
  return `<form method="post" action="/firewall/unban" class="inline"
        data-confirm="Unblock ${esc(entry.ip)}? It will be able to connect again immediately.">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="ip" value="${esc(entry.ip)}">
      <button class="btn small" type="submit">${icon("check")} Unblock</button>
    </form>`;
}

/**
 * One list out of two sources.
 *
 * An address can be held by a jail and by a hand-written rule at the same time,
 * and those are genuinely two rules with two different lifetimes — so they stay
 * two rows rather than being merged into one that no single button can clear.
 */
function blockedList(status) {
  const rows = [];
  for (const jail of status.jails || []) {
    for (const ban of jail.bans || []) {
      rows.push({ ...ban, jail: jail.name });
    }
  }
  for (const rule of status.manual || []) {
    rows.push({ ...rule, jail: null });
  }
  // Newest first; the hand-written rules carry no timestamp and sit at the top,
  // which is also where somebody who just added one will look for it.
  rows.sort((a, b) => String(b.since || "9999").localeCompare(String(a.since || "9999")));
  return rows;
}

exports.index = ({ csrf, user, status, myIp, canManage, flash, err }) => {
  const blocked = blockedList(status);
  const auto = blocked.filter((b) => b.jail).length;
  const jails = status.jails || [];

  const warnings = [
    !status.ufw.active
      ? `<div class="alert bad">${icon("alert")}<div><strong>The firewall is not
         running.</strong> Every port on this machine is reachable. Rules added
         here are recorded but enforce nothing until ufw is enabled.</div></div>`
      : "",
    !status.fail2ban
      ? `<div class="alert warn">${icon("alert")}<div>fail2ban is not answering, so
         nothing is watching the logs for brute-force attempts. Only the rules
         listed below are in force.</div></div>`
      : "",
  ].join("");

  return shell(
    "Firewall",
    `${flashes({ msg: flash, err })}
    ${warnings}

    <div class="stats4">
      ${stat(blocked.length, "blocked now", "ban")}
      ${stat(auto, "by a jail", "shield")}
      ${stat(blocked.length - auto, "by hand", "lock")}
      ${stat(jails.length, jails.length === 1 ? "jail watching" : "jails watching", "eye")}
    </div>

    ${
      canManage
        ? card(
            "Block an address",
            `<form method="post" action="/firewall/ban" class="fw-block"
                  data-confirm="Add this block? The address will lose SSH and this panel at once.">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <label>Address or range
                <span class="hint">one IP, or a CIDR block no wider than /24</span>
                <input name="ip" required autocomplete="off" spellcheck="false"
                  placeholder="203.0.113.45"
                  pattern="[0-9A-Fa-f.:]{2,45}(/[0-9]{1,3})?"></label>
              <label>Reason <span class="hint">optional, kept on the rule</span>
                <input name="note" autocomplete="off" maxlength="60"
                  placeholder="probing /wp-login"></label>
              <button class="btn danger" type="submit">${icon("ban")} Block</button>
            </form>
            <p class="muted small">A block added here has no expiry — it stands until
              somebody removes it. You are connected from
              <span class="mono">${esc(myIp || "an unknown address")}</span>; a rule
              covering it is refused, as is one covering this machine's own
              addresses, because neither could be undone from this page.</p>`,
            { icon: "ban", className: "fw-form" }
          )
        : ""
    }

    <div class="split three fw-split">
    ${card(
      "Blocked addresses",
      blocked.length
        ? `<table class="rows">
            <thead><tr>
              <th>Address</th><th>Blocked by</th><th>Since</th>
              <th>Expires</th><th>Reason</th><th></th>
            </tr></thead>
            <tbody>${blocked
              .map(
                (b) => `<tr>
                  <td class="mono">${esc(b.ip)}</td>
                  <td>${sourcePill(b)}</td>
                  <td class="mono small">${esc(b.since || "—")}</td>
                  <td>${expiry(b)}</td>
                  <td class="small muted">${
                    b.jail
                      ? esc("repeated failures against " + b.jail)
                      : esc(b.note || "added from this panel")
                  }</td>
                  <td class="right">${canManage ? unbanButton(csrf, b) : ""}</td>
                </tr>`
              )
              .join("")}</tbody>
          </table>
          <p class="muted small">Times are the server's own clock (${esc(
            status.tz || "server time"
          )}). A jail's ban lifts by itself when it expires; unblocking here also
            clears the strikes that caused it, so the address starts again from zero.</p>`
        : empty(
            "check",
            "Nothing is blocked",
            "No address is currently shut out, by a jail or by hand."
          ),
      { icon: "ban", className: "hud", bodyClass: "tbl pad" }
    )}

    ${card(
      "What is watching",
      jails.length
        ? `<table class="rows">
            <thead><tr><th>Jail</th><th>Blocked now</th><th>Rule</th><th>Ban lasts</th><th>Blocked ever</th></tr></thead>
            <tbody>${jails
              .map(
                (j) => `<tr>
                  <td class="strong">${esc(j.name)}</td>
                  <td>${(j.bans || []).length}</td>
                  <td class="small muted">${
                    j.maxretry != null && j.findtime != null
                      ? esc(
                          j.maxretry +
                            " failures within " +
                            duration(j.findtime)
                        )
                      : "—"
                  }</td>
                  <td class="small">${
                    j.bantime == null
                      ? "—"
                      : j.bantime < 0
                        ? "until removed"
                        : esc(duration(j.bantime))
                  }</td>
                  <td class="small muted">${j.total == null ? "—" : j.total}</td>
                </tr>`
              )
              .join("")}</tbody>
          </table>
          <p class="muted small">Jails read the logs and act on their own. The
            <span class="mono">recidive</span> jail watches the other jails: an address
            that keeps coming back after its ban expires gets a much longer one.</p>`
        : `<p class="muted">No jails are configured.</p>`,
      { icon: "shield", bodyClass: "tbl pad" }
    )}

    ${card(
      "Open to everyone",
      (status.allowed || []).length
        ? `<table class="rows">
            <thead><tr><th>Port</th><th>Action</th><th>From</th><th>What it is</th></tr></thead>
            <tbody>${status.allowed
              .map(
                (r) => `<tr>
                  <td class="mono small">${esc(r.to)}</td>
                  <td class="small">${esc(r.action)}</td>
                  <td class="small muted">${esc(r.from)}</td>
                  <td class="small muted">${esc(r.comment || "—")}</td>
                </tr>`
              )
              .join("")}</tbody>
          </table>
          <p class="muted small">Everything not listed is refused by default. These
            rules are part of the machine's setup and are changed from a shell, not
            from here — closing one of them from a web page is how a panel locks
            itself out.</p>`
        : `<p class="muted">No ports are open.</p>`,
      { icon: "network", bodyClass: "tbl pad" }
    )}
    </div>`,
    {
      user,
      csrf,
      active: "firewall",
      pattern: "b",
      fill: true,
      heading: "Firewall",
      subtitle:
        "Who can reach this machine. Blocks placed by the jails and blocks placed by hand, in one list.",
    }
  );
};
