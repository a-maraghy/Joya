"use strict";
/**
 * Inline SVG icon set.
 *
 * Inline because the CSP allows no external images or scripts, and an admin
 * panel that can grant SSH access is the last place to be pulling assets off a
 * CDN. Stroke-based at 1.6px on a 24px grid to match the thin line icons on
 * the company site; they inherit `currentColor`, so a single CSS rule recolours
 * every icon in a section.
 */

const PATHS = {
  // --- navigation ---------------------------------------------------------
  overview:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  core: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  agents:
    '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2"/><path d="M9 13.5h.01M15 13.5h.01"/><path d="M9.5 17h5"/>',
  channels:
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20.5l1.6-4.7A8.3 8.3 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>',
  services:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  addons:
    '<path d="M10 3h4a1 1 0 0 1 1 1v1.5a1.8 1.8 0 1 0 3.5 0V4a1 1 0 0 1 1-1"/><path d="M19.5 3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H18a1.8 1.8 0 1 0 0 3.5h1.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V16a1.8 1.8 0 1 0-3.5 0v1.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1"/>',
  memory:
    '<path d="M12 5a3 3 0 0 0-5.8-1A2.8 2.8 0 0 0 4 6.6a3 3 0 0 0-.6 4.6A3 3 0 0 0 4 16a2.8 2.8 0 0 0 2.4 3.7A3 3 0 0 0 12 19Z"/><path d="M12 5a3 3 0 0 1 5.8-1A2.8 2.8 0 0 1 20 6.6a3 3 0 0 1 .6 4.6A3 3 0 0 1 20 16a2.8 2.8 0 0 1-2.4 3.7A3 3 0 0 1 12 19Z"/><path d="M12 5v14"/>',
  credentials:
    '<circle cx="8" cy="12" r="3.2"/><path d="M11.2 12H21l-1.6 2-1.7-1.6L16 14l-1.6-2"/>',
  keys: '<circle cx="12" cy="8" r="4"/><path d="M12 12v8"/><path d="M9.5 16.5h5"/><path d="M9.5 19.5h5"/>',
  devices:
    '<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M1.5 19h16"/><rect x="17.5" y="10" width="5" height="9" rx="1.5"/>',
  audit:
    '<path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/>',
  guide:
    '<path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2Z"/><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2Z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.2 4.4a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7 2 2 0 1 1 0 4Z"/>',

  // --- actions ------------------------------------------------------------
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart:
    '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16Z"/><path d="M14 6l4 4"/>',
  save: '<path d="M5 3h11l3 3v15a0 0 0 0 1 0 0H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h7V3"/><rect x="8" y="13" width="8" height="6"/>',
  logs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15h4.5"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 5.8"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.7l1.5-1.5"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  alert:
    '<path d="M12 3.5 22 20H2Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  reindex: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16"/><path d="M4 20v-4h4"/>',

  // --- channels & integrations -------------------------------------------
  telegram: '<path d="M21 4.5 2.8 11.4a.5.5 0 0 0 .05.94l4.5 1.3 1.7 5.2a.5.5 0 0 0 .87.16l2.4-2.7 4.6 3.4a.5.5 0 0 0 .79-.29L21.5 5.1a.5.5 0 0 0-.5-.6Z"/><path d="M7.35 13.64 18 7"/>',
  whatsapp:
    '<path d="M3.5 20.5l1.3-4.5A8.2 8.2 0 1 1 8 19.3Z"/><path d="M9 9.2c.2-.5.4-.5.7-.5h.5c.2 0 .4 0 .6.5l.7 1.6c.1.3 0 .5-.1.6l-.4.5c-.1.2-.2.3 0 .6a6 6 0 0 0 2.6 2.2c.3.1.4 0 .6-.1l.5-.6c.2-.2.4-.1.6 0l1.5.8c.4.2.5.3.5.5a1.8 1.8 0 0 1-1.3 1.5 3 3 0 0 1-2-.2 10 10 0 0 1-4.9-4.4 3.4 3.4 0 0 1-.6-2 2 2 0 0 1 .5-1.5Z"/>',
  voice:
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M9 21h6"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>',
  file: '<path d="M6 3h8l4 4v14a0 0 0 0 1 0 0H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17l5-5 4 4 2.5-2.5L20 17"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="12" r="2.5"/><path d="M6 8.5v7"/><path d="M8.4 7.2A6 6 0 0 0 14.5 11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  webhook:
    '<circle cx="12" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M10.5 9.6 7.6 14.4"/><path d="M13.5 9.6l2.9 4.8"/><path d="M9 17h6"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  // A passkey: Windows Hello's fingerprint.
  fingerprint:
    '<path d="M7.5 4.6A8 8 0 0 1 20 11.5v1"/><path d="M4.4 8.2A8 8 0 0 0 4 11.5V14"/><path d="M8 19.5a12 12 0 0 0 1-6V11.5a3 3 0 0 1 6 0v2a16 16 0 0 1-.8 5"/><path d="M12 11.5v2.5a20 20 0 0 1-1.6 7"/><path d="M17.8 15.5a22 22 0 0 1-.9 4.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6Z"/><path d="M9 12l2 2 4-4"/>',
  users:
    '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.4 3.4 0 0 1 0 5.6"/><path d="M17.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  network:
    '<circle cx="12" cy="4.5" r="2"/><circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="19" r="2"/><path d="M12 6.5v4M12 10.5 5.6 17.3M12 10.5l6.4 6.8"/>',
  activity: '<path d="M2.5 12h4l2.5-7 5 14 2.5-7h5"/>',
  dots: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M4.8 8.5v9.7A1.8 1.8 0 0 0 6.6 20h10.8a1.8 1.8 0 0 0 1.8-1.8V8.5"/><path d="M10 12h4"/>',
  power: '<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  sidebar:
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
};

/**
 * Render one icon.
 * @param {string} name  key from PATHS
 * @param {number} size  pixel size (square)
 */
function icon(name, size = 18) {
  const body = PATHS[name];
  if (!body) return "";
  return (
    `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

function has(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

module.exports = { icon, has, names: Object.keys(PATHS) };
