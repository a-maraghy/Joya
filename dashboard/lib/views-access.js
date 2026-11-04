"use strict";
/**
 * Users, roles, and your own account.
 *
 * Two rules run through all of it. Passwords and TOTP secrets are shown exactly
 * once, at the moment they are created, and never again -- there is no "reveal"
 * anywhere on these pages, because a panel that can show you a secret is a
 * panel an attacker can ask to show them one. And every screen that removes
 * access says plainly what breaks, since "disable user" reads harmless right up
 * until it locks the last administrator out of their own machine.
 */

const { esc, shell, card, flashes, icon, stamp, ago, empty, enrolSteps } = require("./ui");
const rbac = require("./rbac");
// Password-only sign-in (lib/signin.js): no authenticator, no passkeys, so nothing about them is shown.
const PASSWORD_ONLY = require("./signin").passwordOnly;
const EMAIL_HINT = PASSWORD_ONLY ? "" : `<span class="hint">what their authenticator app shows beside the code</span>`;

/**
 * A role as a pill: the administrator solid, every other role neutral. (The
 * old "brand" pill picked up the top bar's logo rule and broke its shape.)
 */
const roleBadge = (role) =>
  role
    ? `<span class="pill ${role.permissions && role.permissions.includes("*") ? "solid" : "neutral"}">${esc(role.label)}</span>`
    : `<span class="pill bad">no role</span>`;

/** "all permissions", "9 permissions". */
function permsText(role) {
  const n = permCount(role);
  return n === "all" ? "all permissions" : n + " permission" + (n === "1" ? "" : "s");
}

/** A modal's frame (.cc-modal, opened by app.js JoyaUI from [data-modal-open]). */
function modal(id, title, sub, ic, body, foot, size) {
  return `<section class="cc-modal os ${size || "narrow"}" id="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}-t" hidden>
    <div class="cc-mh">${icon(ic, 18)}<div class="cc-min0"><h2 id="${esc(id)}-t">${esc(title)}</h2>${sub ? `<small>${esc(sub)}</small>` : ""}</div>
      <span class="cc-sp"><button type="button" class="cc-ibtn" data-modal-close aria-label="Close">${icon("close", 16)}</button></span></div>
    ${body}
    <div class="mf">${foot}</div></section>`;
}

/** A permission count that reads honestly for the wildcard administrator. */
function permCount(role) {
  if (!role) return "0";
  if (role.permissions.includes("*")) return "all";
  return String(role.permissions.length);
}

/* ---------------------------------------------------------------- users --- */

/**
 * Users: one row a person, every cell's first line on one 22px line, stacked
 * into label/value cards on a phone. Manage and Add user open dialogs (the
 * full pages /users/:id and /users/new stay for no-JS and for password reset).
 *
 * @param o { csrf, user, users, roles, missingEmail, flash, err, meId, canManage,
 *            sessionsOf? (userId -> number of signed-in browsers) }
 */
exports.users = ({ csrf, user, users, roles, missingEmail = 0, flash, err, meId, canManage, sessionsOf }) => {
  const admins = users.filter((u) => u.role && u.role.permissions.includes("*") && !u.disabled);
  const status = (u) =>
    u.disabled ? `<span class="pill bad">disabled</span>` : PASSWORD_ONLY || u.totp_confirmed ? `<span class="pill ok">active</span>` : `<span class="pill warn">enrolment pending</span>`;
  const rows = users
    .map(
      (u) => `<tr>
        <td class="first" data-h="User"><div class="l1"><b class="ink">${esc(u.display_name || u.username)}</b></div>
          <div class="l2 mono">${esc(u.username)}</div>
          <div class="l2">${u.email ? esc(u.email) : `<span class="pill warn">no email</span>`}</div></td>
        <td data-h="Role"><div class="l1">${roleBadge(u.role)}<span class="muted small">${permsText(u.role)}</span></div></td>
        <td data-h="Status"><div class="l1">${status(u)}</div></td>
        <td data-h="Last sign-in"><div class="l1 mono small">${u.last_login_at ? esc(ago(u.last_login_at)) : "never"}</div></td>
        <td class="right nolabel" data-h=""><div class="l1"><a class="btn small" href="/users/${u.id}"${canManage ? ` data-modal-open="m-user-${u.id}"` : ""}>${icon("edit", 14)} ${
        canManage ? "Manage" : "View"
      }</a></div></td>
      </tr>`
    )
    .join("");

  const roleOpts = (cur) => roles.map((r) => `<option value="${r.id}"${String(r.id) === String(cur) ? " selected" : ""}>${esc(r.label)} — ${esc(permsText(r))}</option>`).join("");
  const dialogs = canManage
    ? users
        .map((u) => {
          const isSelf = u.id === meId;
          const lastAdmin = !!(u.role && u.role.permissions.includes("*") && !u.disabled && admins.length <= 1);
          const n = typeof sessionsOf === "function" ? sessionsOf(u.id) : null;
          const fid = "f-user-" + u.id;
          return modal(
            "m-user-" + u.id,
            "Manage " + (u.display_name || u.username),
            u.username,
            "user",
            `<form class="mb" method="post" action="/users/${u.id}" id="${fid}" autocomplete="off">
              <input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="/users">
              ${lastAdmin ? `<div class="alert warn">${icon("alert")}<div>The last active administrator: the role stays and the account cannot be disabled or deleted until another administrator exists.</div></div>` : ""}
              <label>Display name<input name="display_name" value="${esc(u.display_name || "")}"></label>
              <label>Email ${EMAIL_HINT}<input name="email" type="email" value="${esc(u.email || "")}" required spellcheck="false"></label>
              <label>Role<select name="role_id"${lastAdmin ? " disabled" : ""}>${roleOpts(u.role_id)}</select>${lastAdmin ? `<input type="hidden" name="role_id" value="${u.role_id}">` : ""}</label>
              <label class="check"><input type="checkbox" name="disabled" value="1"${u.disabled ? " checked" : ""}${isSelf || lastAdmin ? " disabled" : ""}>
                <span>Disabled — cannot sign in${isSelf ? " (not yourself)" : ""}</span></label>
              ${
                n == null || isSelf
                  ? ""
                  : `<p class="muted small">${n ? n + " signed-in browser" + (n === 1 ? "" : "s") : "Not signed in anywhere."}${
                      n ? ` <button type="submit" class="linkish" form="f-user-out-${u.id}">Sign them all out</button>` : ""
                    }</p>`
              }
            </form>
            ${PASSWORD_ONLY ? "" : `<form method="post" action="/users/${u.id}/totp" id="f-user-totp-${u.id}" data-confirm-dlg="Reset ${esc(u.username)}'s authenticator?" data-confirm-body="Their current authenticator stops working at once and any passkeys (Windows Hello) are removed; they enrol again at their next sign-in." data-confirm-yes="Reset"><input type="hidden" name="_csrf" value="${esc(csrf)}"></form>`}
            ${isSelf || lastAdmin ? "" : `<form method="post" action="/users/${u.id}/delete" id="f-user-del-${u.id}" data-confirm-dlg="Delete ${esc(u.username)}?" data-confirm-body="They lose access at once. The audit log keeps what they did." data-confirm-yes="Delete"><input type="hidden" name="_csrf" value="${esc(csrf)}"></form>`}
            ${n ? `<form method="post" action="/users/${u.id}/signout-all" id="f-user-out-${u.id}" data-confirm-dlg="Sign ${esc(u.username)} out everywhere?" data-confirm-body="Every browser signed in as them ends its session now, and any live voice call on it ends too." data-confirm-yes="Sign out"><input type="hidden" name="_csrf" value="${esc(csrf)}"></form>` : ""}`,
            `${PASSWORD_ONLY ? "" : `<button type="submit" class="btn small" form="f-user-totp-${u.id}">Reset authenticator</button>`}${
              isSelf || lastAdmin ? "" : `<button type="submit" class="btn small danger" form="f-user-del-${u.id}">${icon("trash", 14)} Delete</button>`
            }<a class="btn small" href="/users/${u.id}">Password…</a><span class="sp"></span><button type="button" class="btn" data-modal-close>Cancel</button><button type="submit" class="btn primary" form="${fid}">Save</button>`
          );
        })
        .join("") +
      modal(
        "m-user-add",
        "Add a user",
        PASSWORD_ONLY ? "They sign in with the username and password you give them." : "They enrol their authenticator at first sign-in.",
        "plus",
        `<form class="mb" method="post" action="/users/new" id="f-user-add" autocomplete="off">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>Username <span class="hint">what they type to sign in</span><input name="username" required pattern="[a-zA-Z0-9._\\-]{3,32}" autocomplete="off" spellcheck="false"></label>
          <label>Display name <span class="hint">optional</span><input name="display_name"></label>
          <label>Email ${EMAIL_HINT}<input name="email" type="email" required spellcheck="false" placeholder="name@company.com"></label>
          <label>Role<select name="role_id">${roleOpts((roles.find((r) => r.name === "viewer") || roles[roles.length - 1] || {}).id)}</select></label>
          <label>Temporary password <span class="hint">shown once, on the next screen</span><input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
        </form>`,
        `<span class="sp"></span><button type="button" class="btn" data-modal-close>Cancel</button><button type="submit" class="btn primary" form="f-user-add">Add user</button>`
      )
    : "";

  return shell(
    "Users",
    `${flashes({ msg: flash, err })}
    ${
      missingEmail
        ? `<div class="alert warn">${icon("alert")}<div>${missingEmail} account${
            missingEmail === 1 ? " has" : "s have"
          } no email address yet.${PASSWORD_ONLY ? "" : ` It is what the authenticator app shows beside the
           code,`} Add it from ${missingEmail === 1 ? "that account" : "each account"} below.
           Sign-in is unaffected either way.</div></div>`
        : ""
    }

    ${card(
      "People with access",
      users.length
        ? `<table class="rows stack aligned">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table>`
        : empty("users", "No users yet", "Add someone to give them access to this panel."),
      {
        icon: "users",
        actions: canManage ? `<a class="btn primary small" href="/users/new" data-modal-open="m-user-add">${icon("plus")} Add user</a>` : "",
      }
    )}

    ${card(
      "How access works",
      `<p class="muted">A user has exactly one role, and the role carries the permissions and
        the scope. To give someone access to only one agent, make a role whose agent scope
        names that agent rather than making a per-person exception — scopes are visible on
        the roles page, one-off exceptions are visible nowhere.</p>
      <div class="chips">${roles
        .map(
          (r) =>
            `<a class="chip-link" href="/roles">${esc(r.label)}
               <span class="muted">${r.user_count} user${r.user_count === 1 ? "" : "s"}</span></a>`
        )
        .join("")}</div>`,
      { icon: "info" }
    )}
    ${dialogs}`,
    {
      user,
      csrf,
      active: "users",
      pattern: "c",
      heading: "Users",
      subtitle: "Who can sign in to Joya, and what they are allowed to do once they are in.",
    }
  );
};

exports.userNew = ({ csrf, user, roles, form = {}, errors = [] }) =>
  shell(
    "Add user",
    `${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}

    ${card(
      "New user",
      `<form method="post" action="/users/new">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <div class="grid cols-2">
          <label>Username <span class="hint">what they type to sign in</span>
            <input name="username" value="${esc(form.username || "")}" required
              pattern="[a-zA-Z0-9._\\-]{3,32}" autocomplete="off"></label>
          <label>Display name <span class="hint">optional</span>
            <input name="display_name" value="${esc(form.display_name || "")}"></label>
        </div>
        <label>Email
          ${EMAIL_HINT}
          <input name="email" type="email" value="${esc(form.email || "")}" required
            autocomplete="off" spellcheck="false" placeholder="name@company.com"></label>
        <label>Role
          <select name="role_id">
            ${roles
              .map(
                (r) =>
                  `<option value="${r.id}"${
                    String(form.role_id) === String(r.id) ? " selected" : ""
                  }>${esc(r.label)} — ${esc(r.description || permCount(r) + " permissions")}</option>`
              )
              .join("")}
          </select></label>
        <label>Temporary password <span class="hint">shown once, on the next screen — send it over a channel they already trust</span>
          <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
        <button class="btn primary" type="submit">${icon("save")} Create user</button>
      </form>`,
      { icon: "user" }
    )}

    ${card(
      "What happens next",
      PASSWORD_ONLY
        ? `<ol class="steps">
        <li>You hand them the username and temporary password, over a channel they already trust.</li>
        <li>They sign in and change the password from their account page.</li>
      </ol>`
        : `<ol class="steps">
        <li>You get a one-time enrolment link and QR code for their authenticator app.</li>
        <li>They scan it and confirm a code — until then the account cannot sign in.</li>
        <li>They sign in with the temporary password and change it from their account page.</li>
      </ol>
      <p class="muted small">Two-factor is not optional here. Every account on this panel can
        reach something worth protecting, so there is no path that skips enrolment.</p>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "users",
      heading: "Add user",
      subtitle: PASSWORD_ONLY ? "Creates the account with a temporary password." : "Creates the account and starts authenticator enrolment.",
      actions: `<a class="btn" href="/users">${icon("chevron")} All users</a>`,
    }
  );

exports.userEnrol = ({ csrf, user, target, qr, secret, password, reset }) =>
  PASSWORD_ONLY
    ? shell(
        "Created " + target.username,
        `<div class="alert good">${icon("check")}<div>
      <strong>${esc(target.username)}</strong> has been created. The password is shown once.</div></div>
    ${card(
      "Hand these over",
      `<p class="muted small">Username</p>
      <pre class="secret">${esc(target.username)}</pre>
      <p class="muted small">Temporary password</p>
      <pre class="secret">${esc(password)}</pre>
      <p>They sign in at this panel's address with these, then change the password from their account page.</p>
      <div class="btn-row">
        <a class="btn primary" href="/users">${icon("check")} Done</a>
        <a class="btn" href="/users/${target.id}">Manage this user</a>
      </div>`,
      { icon: "lock" }
    )}`,
        { user, csrf, active: "users", heading: "New user " + target.username, subtitle: "Shown once. There is no way to display the password again." }
      )
    :
  shell(
    "Enrol " + target.username,
    `${
      reset
        ? `<div class="alert good">${icon("check")}<div>
      Two-factor for <strong>${esc(target.username)}</strong> has been reset: their old authenticator
      stopped working${
        reset.passkeys
          ? `, and their ${reset.passkeys} passkey${reset.passkeys === 1 ? " was" : "s were"} removed (Windows Hello no longer signs them in)`
          : " (they had no passkeys)"
      }. Everything on this page is shown once.</div></div>`
        : `<div class="alert good">${icon("check")}<div>
      <strong>${esc(target.username)}</strong> has been created. Everything on this page is
      shown once — leave it before handing it over and you will have to reset both.</div></div>`
    }

    ${card(
      "Hand these over",
      `<div class="grid cols-2">
        <div>
          <p class="muted small">Temporary password</p>
          <pre class="secret">${esc(password)}</pre>
          <p class="muted small">Authenticator secret, if they cannot scan</p>
          <pre class="secret">${esc(secret)}</pre>
        </div>
        <div class="qr-wrap">
          <img class="qr" src="${esc(qr)}" alt="Authenticator enrolment QR code" width="200" height="200">
        </div>
      </div>
      ${enrolSteps(target.email)}`,
      { icon: "lock" }
    )}

    ${card(
      "Then",
      `<p>They sign in at this panel's address with the username and temporary password, and the
        first code from their authenticator. The account is marked <em>enrolment pending</em>
        until that first successful sign-in.</p>
      <div class="btn-row">
        <a class="btn primary" href="/users">${icon("check")} Done</a>
        <a class="btn" href="/users/${target.id}">Manage this user</a>
      </div>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "users",
      heading: "Enrolment for " + target.username,
      subtitle: "Shown once. There is no way to display these again.",
    }
  );

exports.userDetail = ({ csrf, user, target, roles, isSelf, lastAdmin, flash, err, passkeyCount = 0 }) =>
  shell(
    target.username,
    `${flashes({ msg: flash, err })}
    ${
      lastAdmin
        ? `<div class="alert warn">${icon("alert")}<div>This is the last active administrator.
           The role cannot be changed and the account cannot be disabled or deleted until
           another administrator exists — otherwise nobody can administer the machine.</div></div>`
        : ""
    }

    ${card(
      "Account",
      `<table class="kv">
        <tr><td>Username</td><td class="mono">${esc(target.username)}</td></tr>
        <tr><td>Email</td><td class="mono small">${
          target.email
            ? esc(target.email)
            : `<span class="pill warn">not set</span>`
        }</td></tr>
        <tr><td>Role</td><td>${roleBadge(target.role)}</td></tr>
        <tr><td>Status</td><td>${
          target.disabled
            ? `<span class="pill bad">disabled</span>`
            : `<span class="pill ok">enabled</span>`
        }</td></tr>
        ${PASSWORD_ONLY ? "" : `<tr><td>Two-factor</td><td>${
          target.totp_confirmed
            ? `<span class="pill ok">enrolled</span>`
            : `<span class="pill warn">enrolment pending</span>
               <div class="muted small">A secret exists and the QR can be scanned; this
                 turns to enrolled the first time a code from it is accepted —
                 ${isSelf ? "confirm one on your account page, or just sign in again" : "which happens at their next sign-in"}.</div>`
        }</td></tr>
        <tr><td>Passkeys</td><td>${
          passkeyCount
            ? `<span class="pill ok">${passkeyCount} registered</span>`
            : `<span class="muted small">none — signs in with the authenticator code</span>`
        }</td></tr>`}
        <tr><td>Created</td><td class="mono small">${esc(stamp(target.created_at))}${
          target.created_by ? ` by ${esc(target.created_by)}` : ""
        }</td></tr>
        <tr><td>Last sign-in</td><td class="mono small">${
          target.last_login_at ? esc(stamp(target.last_login_at)) : "never"
        }</td></tr>
      </table>`,
      { icon: "user" }
    )}

    ${card(
      "Role and status",
      `<form method="post" action="/users/${target.id}">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Display name
          <input name="display_name" value="${esc(target.display_name || "")}"></label>
        <label>Email
          ${PASSWORD_ONLY ? "" : `<span class="hint">what their authenticator app shows beside the code${
            target.totp_confirmed
              ? " — changing it does not disturb an enrolled phone"
              : ""
          }</span>`}
          <input name="email" type="email" value="${esc(target.email || "")}" required
            autocomplete="off" spellcheck="false" placeholder="name@company.com"></label>
        <label>Role
          <select name="role_id"${lastAdmin ? " disabled" : ""}>
            ${roles
              .map(
                (r) =>
                  `<option value="${r.id}"${r.id === target.role_id ? " selected" : ""}>${esc(
                    r.label
                  )}</option>`
              )
              .join("")}
          </select>${lastAdmin ? `<input type="hidden" name="role_id" value="${target.role_id}">` : ""}
        </label>
        <label class="check">
          <input type="checkbox" name="disabled" value="1"${target.disabled ? " checked" : ""}${
            lastAdmin || isSelf ? " disabled" : ""
          }>
          <span>Disabled — keeps the account and its history, blocks sign-in${
            isSelf ? " (you cannot disable yourself)" : ""
          }</span></label>
        <button class="btn primary" type="submit">${icon("save")} Save</button>
      </form>`,
      { icon: "shield" }
    )}

    ${card(
      "Recovery",
      `<p class="muted small">${PASSWORD_ONLY ? "This invalidates the password they have now. Use it when someone has lost their password, not as routine maintenance." : `Both of these invalidate what the user currently has. Use them when
        someone has lost a device or a password, not as routine maintenance.`}</p>
      <div class="grid${PASSWORD_ONLY ? "" : " cols-2"}">
        <form method="post" action="/users/${target.id}/password">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>New temporary password
            <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
          <button class="btn" type="submit">${icon("lock")} Reset password</button>
        </form>
        ${PASSWORD_ONLY ? "" : `<form method="post" action="/users/${target.id}/totp"
              data-confirm="Reset two-factor for ${esc(target.username)}? Their current authenticator stops working immediately${passkeyCount ? `, and their ${passkeyCount} passkey${passkeyCount === 1 ? " is" : "s are"} removed` : ""}.">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <p class="muted small">Resetting two-factor issues a new secret, removes their passkeys
            (Windows Hello), and blocks sign-in until they enrol again.</p>
          <button class="btn" type="submit">${icon("reindex")} Reset two-factor</button>
        </form>`}
      </div>`,
      { icon: "lock" }
    )}

    ${
      isSelf || lastAdmin
        ? ""
        : card(
            "Delete",
            `<p class="muted small">Removes the account outright. Their entries in the sign-in log
              stay, because an audit trail you can delete is not one.</p>
            <form method="post" action="/users/${target.id}/delete"
                  data-confirm="Delete ${esc(target.username)}? This cannot be undone.">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn danger" type="submit">${icon("trash")} Delete user</button>
            </form>`,
            { icon: "trash", className: "danger-zone" }
          )
    }`,
    {
      user,
      csrf,
      active: "users",
      heading: target.display_name || target.username,
      subtitle: "Account, role, and recovery.",
      actions: `<a class="btn" href="/users">${icon("chevron")} All users</a>`,
    }
  );

/* ---------------------------------------------------------------- roles --- */

/**
 * Roles: the same aligned table as Users. Manage / New role open the editor as
 * a dialog (name, scope, permissions grouped as in rbac); the full pages
 * /roles/:id and /roles/new stay for no-JS. Built-in roles keep their name,
 * the administrator's permissions are locked, and a role still held by
 * someone cannot be deleted.
 *
 * @param o { csrf, user, roles, flash, err, canManage, agents, channels }
 */
exports.roles = ({ csrf, user, roles, flash, err, canManage, agents = [], channels = [] }) => {
  const scopeText = (r) =>
    `agents: ${esc(rbac.scopeLabel(rbac.parseScope(r.agent_scope)))} · channels: ${esc(rbac.scopeLabel(rbac.parseScope(r.channel_scope)))}`;
  const rows = roles
    .map(
      (r) => `<tr>
        <td class="first" data-h="Role"><div class="l1">${roleBadge(r)}${r.builtin ? `<span class="tag-s">built-in</span>` : ""}</div>
          ${r.description ? `<div class="l2">${esc(r.description)}</div>` : ""}</td>
        <td data-h="Users"><div class="l1 mono small">${r.user_count}</div></td>
        <td data-h="Permissions"><div class="l1">${permsText(r)}</div></td>
        <td data-h="Scope"><div class="l1 small">${scopeText(r)}</div></td>
        <td class="right nolabel" data-h=""><div class="l1"><a class="btn small" href="/roles/${r.id}"${canManage ? ` data-modal-open="m-role-${r.id}"` : ""}>${icon("edit", 14)} ${
        canManage && !r.permissions.includes("*") ? "Manage" : "View"
      }</a></div></td>
      </tr>`
    )
    .join("");

  const editor = (r, isNew) => {
    const held = new Set(r.permissions || []);
    const wildcard = held.has("*");
    const id = isNew ? "new" : String(r.id);
    const fid = "f-role-" + id;
    const readOnly = wildcard;
    return modal(
      "m-role-" + id,
      isNew ? "New role" : "Manage " + r.label,
      wildcard ? "The administrator role always has every permission." : "Permissions and scope",
      "shield",
      `<form class="mb" method="post" action="${isNew ? "/roles/new" : "/roles/" + r.id}" id="${fid}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="/roles">
        <div class="grid cols-2">
          <label>Name <span class="hint">${isNew ? "lowercase, used internally" : "cannot be changed"}</span>
            <input name="name" value="${esc(r.name || "")}"${isNew ? ' required pattern="[a-z0-9_\\-]{2,32}"' : " readonly"}></label>
          <label>Label <span class="hint">what people see</span><input name="label" value="${esc(r.label || "")}" required${readOnly ? " readonly" : ""}></label>
        </div>
        <label>Description<input name="description" value="${esc(r.description || "")}"${readOnly ? " readonly" : ""}></label>
        ${
          wildcard
            ? `<p class="muted">All agents and all channels, and every permission on the system — including ones added by future updates.</p>`
            : `<div class="grid cols-2">${scopePicker("agent_scope", rbac.parseScope(r.agent_scope), agents, "Agents", "No agents exist yet.", false)}${scopePicker(
                "channel_scope",
                rbac.parseScope(r.channel_scope),
                channels,
                "Channels",
                "No channels exist yet.",
                false
              )}</div>${permGroups(held, false)}`
        }
      </form>
      ${
        !isNew && !r.builtin && !r.user_count
          ? `<form method="post" action="/roles/${r.id}/delete" id="f-role-del-${id}" data-confirm-dlg="Delete the ${esc(r.label)} role?" data-confirm-yes="Delete"><input type="hidden" name="_csrf" value="${esc(csrf)}"></form>`
          : ""
      }`,
      `${
        !isNew && !r.builtin
          ? r.user_count
            ? `<span class="muted small">${r.user_count} user${r.user_count === 1 ? " holds" : "s hold"} it — move them first to delete it</span>`
            : `<button type="submit" class="btn small danger" form="f-role-del-${id}">${icon("trash", 14)} Delete</button>`
          : ""
      }<span class="sp"></span><button type="button" class="btn" data-modal-close>${readOnly ? "Close" : "Cancel"}</button>${
        readOnly ? "" : `<button type="submit" class="btn primary" form="${fid}">${isNew ? "Create role" : "Save"}</button>`
      }`,
      "wide"
    );
  };

  return shell(
    "Roles",
    `${flashes({ msg: flash, err })}

    ${card(
      "Roles",
      `<table class="rows stack aligned">
        <thead><tr><th>Role</th><th>Users</th><th>Permissions</th><th>Scope</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`,
      {
        icon: "shield",
        actions: canManage ? `<a class="btn primary small" href="/roles/new" data-modal-open="m-role-new">${icon("plus")} New role</a>` : "",
      }
    )}

    ${card(
      "Scopes",
      `<p class="muted">A permission says what someone may do; a scope says which agents and
        channels they may do it to. <code>*</code> means everything, including agents created
        later. A named list means exactly those — an agent added tomorrow will not appear for
        that role until you add it here, which is the point.</p>`,
      { icon: "info" }
    )}
    ${canManage ? roles.map((r) => editor(r, false)).join("") + editor({ permissions: [], agent_scope: "*", channel_scope: "*" }, true) : ""}`,
    {
      user,
      csrf,
      active: "roles",
      pattern: "c",
      heading: "Roles",
      subtitle: "A role carries permissions and a scope. Every user has exactly one.",
    }
  );
};

function scopePicker(name, scope, options, label, emptyNote, readOnly) {
  const all = scope === "*";
  return `<fieldset class="scope">
    <legend>${esc(label)}</legend>
    <label class="check">
      <input type="radio" name="${name}_mode" value="all"${all ? " checked" : ""}${
        readOnly ? " disabled" : ""
      }>
      <span>All — including any created later</span></label>
    <label class="check">
      <input type="radio" name="${name}_mode" value="list"${!all ? " checked" : ""}${
        readOnly ? " disabled" : ""
      }>
      <span>Only the ones ticked below</span></label>
    <div class="scope-list">
      ${
        options.length
          ? options
              .map(
                (o) => `<label class="check">
                  <input type="checkbox" name="${name}" value="${esc(o.slug)}"${
                    !all && scope.includes(o.slug) ? " checked" : ""
                  }${readOnly ? " disabled" : ""}>
                  <span>${esc(o.name || o.slug)} <span class="muted mono small">${esc(
                    o.slug
                  )}</span></span></label>`
              )
              .join("")
          : `<p class="muted small">${esc(emptyNote)}</p>`
      }
    </div>
  </fieldset>`;
}

/** The permission checkboxes, grouped as in rbac. */
function permGroups(held, readOnly) {
  return rbac.PERMISSION_GROUPS.map(
    (g) => `<div class="perm-group">
      <div class="perm-head">
        <h3>${esc(g.label)}</h3>
        ${g.blurb ? `<p class="muted small">${esc(g.blurb)}</p>` : ""}
      </div>
      ${g.perms
        .map(
          (p) => `<label class="check perm">
            <input type="checkbox" name="permissions" value="${esc(p.key)}"${held.has(p.key) ? " checked" : ""}${readOnly ? " disabled" : ""}>
            <span>
              <span class="perm-label">${esc(p.label)}</span>
              ${p.hint ? `<span class="muted small">${esc(p.hint)}</span>` : ""}
            </span>
          </label>`
        )
        .join("")}
    </div>`
  ).join("");
}

/**
 * The role editor. Built-in administrator renders read-only: it is the account
 * of last resort, and a UI that lets you take permissions away from it is a UI
 * that lets you lock yourself out of your own machine at 2am.
 */
exports.roleEdit = ({ csrf, user, role, agents, channels, isNew, readOnly, errors = [], flash }) => {
  const held = new Set(role.permissions || []);
  const wildcard = held.has("*");
  const agentScope = rbac.parseScope(role.agent_scope);
  const channelScope = rbac.parseScope(role.channel_scope);

  return shell(
    isNew ? "New role" : role.label,
    `${flashes({ msg: flash, err: null })}
    ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
    ${
      readOnly
        ? `<div class="alert info">${icon("info")}<div>The administrator role is fixed. It holds
           every permission — including ones added by future updates — and is shown here so you
           can see what that means, not so you can pare it down.</div></div>`
        : ""
    }

    <form method="post" action="${isNew ? "/roles/new" : "/roles/" + role.id}">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<div class="grid cols-2">
          <label>Name <span class="hint">${
            isNew ? "lowercase, used internally" : "cannot be changed"
          }</span>
            <input name="name" value="${esc(role.name || "")}"${
              // The hyphen is escaped because browsers compile `pattern` with
              // the `v` flag, where a trailing `-` in a character class is a
              // syntax error rather than a literal. An uncompilable pattern is
              // silently ignored, so the field would have accepted anything.
              isNew ? " required pattern=\"[a-z0-9_\\-]{2,32}\"" : " disabled"
            }></label>
          <label>Label <span class="hint">what people see</span>
            <input name="label" value="${esc(role.label || "")}" required${
              readOnly ? " disabled" : ""
            }></label>
        </div>
        <label>Description
          <input name="description" value="${esc(role.description || "")}"${
            readOnly ? " disabled" : ""
          }></label>`,
        { icon: "shield" }
      )}

      ${card(
        "Permissions",
        wildcard
          ? `<p class="muted">This role holds every permission on the system.</p>`
          : permGroups(held, readOnly),
        {
          icon: "lock",
          actions: wildcard
            ? ""
            : `<span class="muted small">Ticking a permission also grants what it needs to work.</span>`,
        }
      )}

      ${card(
        "Scope",
        wildcard
          ? `<p class="muted">All agents and all channels.</p>`
          : `<div class="grid cols-2">
              ${scopePicker("agent_scope", agentScope, agents, "Agents", "No agents exist yet.", readOnly)}
              ${scopePicker("channel_scope", channelScope, channels, "Channels", "No channels exist yet.", readOnly)}
            </div>`,
        { icon: "eye" }
      )}

      ${
        readOnly
          ? ""
          : `<div class="btn-row">
              <button class="btn primary" type="submit">${icon("save")} ${
                isNew ? "Create role" : "Save role"
              }</button>
              <a class="btn" href="/roles">Cancel</a>
            </div>`
      }
    </form>

    ${
      !isNew && !readOnly
        ? card(
            "Delete",
            role.user_count
              ? `<p class="muted small">${role.user_count} user${
                  role.user_count === 1 ? " holds" : "s hold"
                } this role. Move them to another role first.</p>`
              : `<form method="post" action="/roles/${role.id}/delete"
                       data-confirm="Delete the ${esc(role.label)} role?">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <button class="btn danger" type="submit">${icon("trash")} Delete role</button>
                </form>`,
            { icon: "trash", className: "danger-zone" }
          )
        : ""
    }`,
    {
      user,
      csrf,
      active: "roles",
      heading: isNew ? "New role" : role.label,
      subtitle: isNew
        ? "Start from nothing and grant only what the job needs."
        : "Changes take effect on the holder's next request.",
      actions: `<a class="btn" href="/roles">${icon("chevron")} All roles</a>`,
    }
  );
};

/* -------------------------------------------------------------- account --- */

/**
 * Passkeys on the account page: this address first (can one be used here, how
 * many are registered for it), then every passkey of the account with its
 * domain, dates and rename / remove. Adding one is done by public/passkey.js;
 * without JavaScript the card explains rather than offering a dead button.
 */
function passkeyCard(csrf, pk) {
  if (!pk) return "";
  const here = pk.rpID;
  const status = !here
    ? `<div class="alert warn">${icon("alert")}<div>Passkeys do not work at this address
         (<span class="mono">${esc(pk.host || "unknown")}</span>).${
           pk.primary ? ` Open <a href="${esc(pk.primary)}/account#passkeys">${esc(pk.primary.replace(/^https:\/\//, ""))}</a> to add or use one.` : ""
         } Sign in here with your authenticator code.</div></div>`
    : pk.here
      ? `<p class="muted">You can sign in at <span class="mono">${esc(here)}</span> with Windows Hello
           (face, fingerprint or PIN) instead of typing the code. The authenticator code always
           stays available as a fallback and still guards root unlock. Every approval asks for
           Windows Hello too, with the code as its fallback.</p>`
      : `<div class="alert info">${icon("info")}<div>No passkey is registered for
           <span class="mono">${esc(here)}</span> yet${pk.list.length ? " — the ones below belong to another address, and a passkey only works where it was added" : ""}.
           Add this device and the next sign-in here asks for Windows Hello instead of the code.</div></div>`;

  const add = here
    ? `<form class="pk-add" id="pk-add" data-csrf="${esc(csrf)}" data-here="${pk.here}" autocomplete="off" hidden>
        <div class="grid cols-2">
          <label>Name for this device
            <input name="name" maxlength="60" value="${esc(pk.suggestedName || "")}" placeholder="e.g. Office laptop"></label>
          ${
            pk.fresh
              ? `<p class="muted small pk-fresh">${icon("check", 14)} You signed in a moment ago, so no code is needed.</p>`
              : `<label>Code from your authenticator
                   <span class="hint">confirms it is you before a new key is added</span>
                   <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000" autocomplete="one-time-code" required></label>`
          }
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">${icon("fingerprint")} Add this device (Windows Hello)</button>
          <span class="muted small pk-msg" role="status" aria-live="polite"></span>
        </div>
      </form>
      <p class="muted small pk-nojs" data-pk-nojs>Adding a passkey needs JavaScript and a browser with passkey support
        (Edge or Chrome on Windows).</p>`
    : "";

  const rows = pk.list
    .map(
      (p) => `<tr>
        <td class="first" data-h="Name"><form method="post" action="/account/passkeys/${p.id}/rename" class="pk-rename" autocomplete="off">
            <input type="hidden" name="_csrf" value="${esc(csrf)}">
            <input name="name" value="${esc(p.name)}" maxlength="60" aria-label="Name of this passkey" required>
            <button class="btn small" type="submit">${icon("save", 14)} Rename</button>
          </form></td>
        <td data-h="Address"><div class="l1 mono small">${esc(p.rp_id)}</div>${p.rp_id === here ? `<div class="l2"><span class="pill ok">this address</span></div>` : ""}</td>
        <td data-h="Added"><div class="l1 mono small">${esc(stamp(p.created_at))}</div></td>
        <td data-h="Last used"><div class="l1 mono small">${p.last_used_at ? esc(stamp(p.last_used_at)) : "never"}</div></td>
        <td class="right nolabel"><div class="l1"><form method="post" action="/account/passkeys/${p.id}/delete" class="inline"
              data-confirm-dlg="Remove the passkey &quot;${esc(p.name)}&quot;?"
              data-confirm-body="Windows Hello on that device stops signing you in here. Your authenticator code keeps working."
              data-confirm-yes="Remove">
            <input type="hidden" name="_csrf" value="${esc(csrf)}">
            <button class="btn small danger" type="submit">${icon("trash", 14)} Remove</button>
          </form></div></td>
      </tr>`
    )
    .join("");

  return card(
    "Passkeys (Windows Hello)",
    `${status}
    ${add}
    ${
      pk.list.length
        ? `<table class="rows stack aligned pk-table">
            <thead><tr><th>Name</th><th>Address</th><th>Added</th><th>Last used</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table>`
        : `<p class="muted small">No passkeys yet.</p>`
    }`,
    { icon: "fingerprint", id: "passkeys" }
  );
}

exports.account = ({ csrf, user, me, flash, err, appearance, passkeys }) =>
  shell(
    "Your account",
    `${flashes({ msg: flash, err })}

    ${card(
      "Signed in as",
      `<table class="kv">
        <tr><td>Username</td><td class="mono">${esc(me.username)}</td></tr>
        <tr><td>Email</td><td class="mono small">${
          me.email ? esc(me.email) : `<span class="pill warn">not set</span>`
        }</td></tr>
        <tr><td>Role</td><td>${roleBadge(me.role)}</td></tr>
        <tr><td>Agent scope</td><td class="mono small">${esc(
          rbac.scopeLabel(rbac.parseScope(me.agent_scope))
        )}</td></tr>
        <tr><td>Channel scope</td><td class="mono small">${esc(
          rbac.scopeLabel(rbac.parseScope(me.channel_scope))
        )}</td></tr>
        <tr><td>Last sign-in</td><td class="mono small">${
          me.last_login_at ? esc(stamp(me.last_login_at)) : "—"
        }</td></tr>
      </table>`,
      { icon: "user" }
    )}

    ${
      appearance
        ? card(
            "JOYA AI appearance",
            `<p class="muted">The core and the sessions view moved to <a href="/joya-ai/settings/appearance">JOYA AI ▸ Settings ▸ Appearance</a>. The theme is in your avatar menu.</p>`,
            { icon: "eye", id: "appearance" }
          )
        : ""
    }

    ${card(
      "Change password",
      `<form method="post" action="/account/password" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Current password
          <input name="current" type="password" required autocomplete="current-password"></label>
        <div class="grid cols-2">
          <label>New password <span class="hint">at least 12 characters</span>
            <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
          <label>Repeat new password
            <input name="password2" type="password" minlength="12" required autocomplete="new-password"></label>
        </div>
        <button class="btn primary" type="submit">${icon("save")} Change password</button>
      </form>`,
      { icon: "lock" }
    )}

    ${PASSWORD_ONLY ? card(
      "Signed-in devices",
      `<p class="muted">You sign in with your username and password.</p>
      <div class="btn-row"><a class="btn" href="/devices">${icon("devices")} Signed-in devices</a></div>`,
      { icon: "devices" }
    ) : card(
      "Authenticator",
      `${
        me.totp_confirmed
          ? `<p class="muted">Your codes come from an authenticator app on your phone —
             Microsoft Authenticator, or any other. They gate sign-in, so moving them is
             worth doing carefully.</p>
           <p class="muted small">Moving does not take effect until a code from the new app
             is accepted, so if something goes wrong halfway your current app keeps working.</p>`
          : `<div class="alert warn">${icon("alert")}<div>This account is
             <strong>enrolment pending</strong>: the panel has not yet seen a code from your
             authenticator. That is what a reset leaves behind — scanning the QR sets up the
             phone, but nothing tells this side it worked until a code arrives. Enter one
             below and it is settled without signing out.</div></div>
           <form method="post" action="/account/authenticator/verify" autocomplete="off">
             <input type="hidden" name="_csrf" value="${esc(csrf)}">
             <label>Code from your authenticator
               <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                 required autocomplete="one-time-code"></label>
             <button class="btn primary" type="submit">${icon("check")} Confirm enrolment</button>
           </form>`
      }
      <div class="btn-row">
        <a class="btn" href="/account/authenticator">${icon("reindex")} Move to another app or phone</a>
        <a class="btn" href="/devices">${icon("devices")} Signed-in devices</a>
      </div>`,
      { icon: "devices" }
    )}

    ${PASSWORD_ONLY ? "" : passkeyCard(csrf, passkeys)}

    ${card(
      "What you can do",
      me.role && me.role.permissions.includes("*")
        ? `<p class="muted">Everything. You hold the administrator role.</p>`
        : `<div class="chips">${(me.role ? me.role.permissions : [])
            .map(
              (p) =>
                `<span class="chip-static">${esc(rbac.PERMISSION_LABEL[p] || p)}</span>`
            )
            .join("")}</div>`,
      { icon: "eye" }
    )}`,
    {
      user,
      csrf,
      active: null,
      crumbs: [["Account", null]],
      heading: me.display_name || me.username,
      subtitle: PASSWORD_ONLY ? "Your own sign-in and role." : "Your own sign-in, authenticator, passkeys and role.",
      assets: passkeys && passkeys.rpID ? ["simplewebauthn-browser.js", "passkey.js"] : [],
    }
  );

/* ------------------------------------------- moving your authenticator --- */

/**
 * Step one: prove it is you, with both factors.
 *
 * The password alone would let a session left open on an unlocked desk move the
 * second factor to somebody else's phone, which is precisely what the second
 * factor is for. So this asks for a current code as well.
 */
exports.reenrolStart = ({ csrf, user, me, err }) =>
  shell(
    "Move your authenticator",
    `${flashes({ err })}
    ${card(
      "Confirm it is you",
      `<p class="muted">This moves your codes to a different app or phone. Nothing changes
        until the new app produces a code this panel accepts — your current one keeps
        working until then.</p>
      <form method="post" action="/account/authenticator" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Your password
          <input name="password" type="password" required autocomplete="current-password" autofocus></label>
        <label>A code from the authenticator you have now
          <span class="hint">proves the old device is still in your hands</span>
          <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
            required autocomplete="one-time-code"></label>
        <button class="btn primary" type="submit">${icon("chevron")} Continue</button>
      </form>`,
      { icon: "lock" }
    )}`,
    {
      user,
      csrf,
      active: null,
      crumbs: [["Account", "/account"], ["Move your authenticator", null]],
      heading: "Move your authenticator",
      subtitle: "For a new phone, or to switch to Microsoft Authenticator.",
      actions: `<a class="btn" href="/account">${icon("chevron")} Your account</a>`,
    }
  );

/** Step two: scan, then prove the new app works before anything is replaced. */
exports.reenrolScan = ({ csrf, user, me, qr, secret, err }) =>
  shell(
    "Scan the new code",
    `${flashes({ err })}
    <div class="alert warn">${icon("alert")}<div>Your current authenticator is still the
      live one. It is replaced the moment a code from the new app is accepted below, and
      not before — so do not delete the old entry until this page says it is done.</div></div>

    ${card(
      "Add it to your authenticator",
      `<div class="grid cols-2">
        <div>
          ${enrolSteps(me.email)}
          <p class="muted small">Can't scan? Enter this secret by hand:</p>
          <pre class="secret">${esc(secret)}</pre>
        </div>
        <div class="qr-wrap">
          <img class="qr" src="${esc(qr)}" alt="Authenticator enrolment QR code" width="200" height="200">
        </div>
      </div>
      <form method="post" action="/account/authenticator/confirm" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Code from the new app
          <input name="code" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
            required autofocus autocomplete="one-time-code"></label>
        <button class="btn primary" type="submit">${icon("check")} Finish the move</button>
      </form>`,
      { icon: "devices" }
    )}`,
    {
      user,
      csrf,
      active: null,
      crumbs: [["Account", "/account"], ["Scan the new code", null]],
      heading: "Scan the new code",
      subtitle: "This page expires in 15 minutes. Leaving it changes nothing.",
      actions: `<a class="btn" href="/account">${icon("chevron")} Cancel</a>`,
    }
  );

/** Shown when a route is reachable but the actor's role does not permit it. */
exports.denied = ({ csrf, user, perm }) =>
  shell(
    "Not permitted",
    card(
      "Not permitted",
      `<p>Your role does not include <code>${esc(perm)}</code>, so this page is not available
        to you.</p>
      <p class="muted small">If that is wrong, an administrator can change it on the
        roles page — permissions belong to roles here, not to people, so the fix is a role
        change rather than an exception.</p>
      <div class="btn-row"><a class="btn primary" href="/">${icon("chevron")} Back</a></div>`,
      { icon: "ban" }
    ),
    { user, csrf, active: null, heading: "Not permitted", subtitle: "Access is decided by your role." }
  );
