# Product

<!-- impeccable:product-schema 1 -->

> Written 2026-10-25 for the stage 1 redesign. The user's interview round could not run here (the
> work was delegated to a sub-agent with no question tool), so the facts below are taken from the
> repository and the user's brief, and every inferred fact is marked _(inferred)_. Correct them in
> place; nothing here is a visual decision.

## Platform

web (also embedded by the JOYA AI desktop app, a Tauri/WebView2 shell on Windows that loads the same
pages, `desktop/`)

## Users

- **The administrator** — one person who owns this VPS and runs his work through it: a planning lead
  at a seeds and herbs exporter in Cairo _(inferred from the Odoo / planning-engine context)_. Uses it
  on a desktop browser at work, in the desktop app on his laptops, and on a phone. Day and night.
- **Other signed-in people** with narrower roles (viewer, scoped agent operators). The sidebar and
  every control respect their permissions; many see only part of the panel.

## Product Purpose

Joya is the private control panel of one Linux server; JOYA AI is the AI chief of staff that lives
on it. One place to talk to JOYA AI (by text or a live voice call), see what its sessions and the
Telegram/WhatsApp agents are doing, decide what is waiting on you, and run the machine (services,
access, keys, firewall, credentials, audit). Success: the administrator knows within seconds whether
anything needs him, and can act without hunting.

## Positioning

A personal operating system for one person's server and AI staff, not a SaaS console: it shows one
machine, one person's agents and one assistant that can hire sessions, ask for approvals and open
pages on its own.

## Operating Context

- Server-rendered pages (Node/Express), no client framework, a strict CSP (no inline script or style,
  no external assets).
- JOYA AI can drive the UI (page.open, settings, widgets) through `ui-actions.js`; the desktop app
  embeds the Command Center with its own hit regions (`joya-desktop*.js`, `data-desktop`).
- Arabic and English both appear in voice and conversation content.

## Capabilities and Constraints

- Every feature, route, permission, form field name, id and data attribute is load-bearing (tests,
  JOYA AI's page map, the desktop app). Redesigns change the look, never the behaviour.
- The JOYA AI core (the sphere / mesh / bot the user picks per person) is a product feature.
- Fonts and every asset are self-hosted under `public/`.

## Brand Commitments

- Name: **JOYA** (the OS is "Joya", the assistant "JOYA AI").
- User decision 2026-10-25: **no leaf logo**; the logo is the word **JOYA** set as text.
- The desktop/app icon is currently the core E bot head (`JOYA_APP_ICON=bot`).

## Evidence on Hand

Real data lives on the server; screenshots use canned fixtures (`tools/story-fixture.cjs`, scratch
servers). No testimonials, customers or figures are to be invented.

## Product Principles

1. Tell me if anything needs me, first.
2. Plain words over jargon; every control names its action.
3. Quiet chrome, so the content and JOYA AI's state carry the screen.
4. Nothing by colour alone; everything by keyboard.

## Accessibility & Inclusion

WCAG 2.2 AA in both themes (user, 2026-10-25): contrast, visible focus, full keyboard use, 44 px
targets on touch, no meaning by colour alone, reduced motion respected, 16 px base text.
