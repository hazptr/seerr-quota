# Theming

## Summary

The UI's entire look — colour AND structural treatment (body/mono font,
corner radius, pane title-bar visibility, border widths, shadows, decorative
prefixes) — is driven by a small set of CSS custom properties (`--sq-*`),
defined once in `app/src/app/globals.css`. Nothing else in the codebase
hardcodes a colour, font stack, radius, or border width.

The app ships a **default theme** ("Seerr-matched": dark slate/gray with an
indigo accent, chosen to sit naturally alongside Seerr itself) and a
**runtime override hook** (`THEME_CSS`) so a deployment can replace any token
or add rules without rebuilding the image.

## User stories

- As an **operator**, I want to point my deployment at a CSS file that
  matches my own site's look, without maintaining a fork of this app.
- As a **maintainer**, I want the shipped default to look professional and
  at-home next to Seerr out of the box, with no configuration required.
- As a **contributor**, I want every visual choice traceable to one token
  table, so a themed screenshot bug report is reproducible from the tokens
  alone.

## Token reference

### Colour

Dark is the default; a light variant applies when the OS prefers light or the
user picks "light" in the header toggle (`data-theme` on `<html>`). Every pair
below meets WCAG AA (4.5:1) for its use.

| Token | Dark (default) | Light | Used for |
|---|---|---|---|
| `--sq-bg` | `#111827` | `#f9fafb` | Page background |
| `--sq-pane-bg` | `#1f2937` | `#ffffff` | Card/pane background |
| `--sq-fg` | `#f3f4f6` | `#111827` | Body text |
| `--sq-muted` | `#9ca3af` | `#374151` | Secondary text |
| `--sq-dim` | `#959dab` | `#4b5563` | Footer, placeholders, de-emphasised text |
| `--sq-rule` | `rgba(255,255,255,.08)` | `rgba(0,0,0,.08)` | Hairline dividers |
| `--sq-pane-rule` | `#374151` | `#e5e7eb` | Card/pane border |
| `--sq-titlebar-bg` / `-fg` | `transparent` / `var(--sq-muted)` | same | Pane title strip |
| `--sq-titlebar-border` | `none` | `none` | Rule under a pane title (e.g. `1px solid var(--sq-pane-rule)`) |
| `--sq-accent` / `-hover` | `#4f46e5` / `#4338ca` | same | Primary button fill, focus outline |
| `--sq-accent-ink` | `#ffffff` | same | Text on `--sq-accent` |
| `--sq-focus-ring` | `rgba(79,70,229,.35)` | same | Selected-row highlight |
| `--sq-shadow` | two-layer soft shadow | lighter | Card elevation |
| `--sq-critical` | `#f87171` | `#dc2626` | Critical/error **text** |
| `--sq-critical-fill` / `-ink` | `#dc2626` / `#ffffff` | same | Destructive button and over-quota bar **fill** |
| `--sq-link` | `#818cf8` | `#4f46e5` | Hyperlinks |
| `--sq-good` | `#22c55e` | `#15803d` | "Healthy" severity step |
| `--sq-warning` | `#f59e0b` | `#b45309` | "Needs attention" severity step |

Status severity keeps the fixed three-step vocabulary from the original
terminal theme — `--sq-good` / `--sq-warning` / `--sq-critical` — for
anything with a real severity (quota usage, member state, sync/pipeline
health, enforcement decisions, audit outcomes), always alongside a text/glyph
indicator, never colour alone.

### Typography & structure

| Token | Default | Effect |
|---|---|---|
| `--sq-font` | system sans-serif stack (no web-font download) | Body/UI text |
| `--sq-font-mono` | system monospace stack | Available for an override to opt back into a monospace UI (set `--sq-font: var(--sq-font-mono)`) |
| `--sq-radius` | `0.5rem` | Card/pane corner radius |
| `--sq-btn-radius` | `var(--sq-radius)` | Button corner radius |
| `--sq-border-width` | `1px` | Every themed border |
| `--sq-rule-style` | `solid` | Sub-rule style (`dashed` in the terminal look) |
| `--sq-titlebar-display` | `block` | Pane title visibility (`none` hides titles) |
| `--sq-heading-prefix` | `''` | Prefix before a `.sq-heading` element's text, e.g. `'"$ "'` |
| `--sq-btn-decoration-prefix` / `-suffix` | `''` | Text around a button's label, e.g. `'"[ "'` / `'" \21B5 ]"'` for a bracket look |
| `--sq-input-prompt` | `''` | Prefix glyph before a text input, e.g. `'"\276F "'` (❯) |
| `--sq-input-caret` | `auto` | `block` restores the terminal block caret (Chromium-only) |

Every structural token above is read by a class in `globals.css` (`.sq-pane`,
`.sq-titlebar`, `.sq-heading`, `.sq-rule`, `.sq-btn*`, `.sq-input*`) — an
override never needs to touch a component, only the token values.

## Writing an override

1. Write a CSS file. It only needs to set the tokens/rules you want to
   change — anything unset falls through to the default theme (the override
   is linked *after* it, so later rules win via normal cascade order).
2. Point `THEME_CSS` at its path **inside the container** (bind-mount it in,
   e.g. `./theme:/theme:ro` + `THEME_CSS=/theme/override.css`).
3. The app serves it at `GET /theme.css`, read fresh from disk on every
   request — no rebuild, and a restart (or even just waiting out the short
   cache window) picks up an edit.
4. Also available: `APP_NAME` (page title / brand text, default `"Seerr
   Quota"`) and `FAVICON_URL` (default `/favicon.svg`, the neutral icon
   shipped in `public/`).

Minimal example — retint the accent and give pane titles a rule:

```css
:root {
  --sq-accent: #0ea5e9;
  --sq-accent-hover: #0284c7;
  --sq-titlebar-border: 1px solid var(--sq-pane-rule);
}
```

See `src/lib/theme/config.ts` for how the three env vars are parsed, and
`src/app/theme.css/route.ts` for the serving route — the path comes only
from `THEME_CSS` (never from a request), so there's no way to use this route
to read an arbitrary file.

## Light and dark

The default theme ships both schemes. With no explicit choice it follows the
OS (`prefers-color-scheme`); the header toggle (system / light / dark) sets
`data-theme` on `<html>`, persisted per browser, which wins over the OS.

An override should set its tokens on a plain `:root` (and, for a scheme-specific
look, inside `@media (prefers-color-scheme: …) { :root { … } }` plus
`:root[data-theme='light'|'dark']`). The default's light block is deliberately
a plain `:root` so it never out-specifies an override's own `:root`.

## Functional requirements

- **FR-UI-1** — Every colour and every structural choice (font, radius,
  border width, title-bar visibility, decorative prefixes) MUST come from a
  `--sq-*` token or a class that reads one; no hardcoded value anywhere else.
- **FR-UI-2** — The app MUST support an explicit light/dark override,
  persisted per browser, that can be set independently of the OS preference
  in both directions. 
- **FR-UI-3** — A runtime override (`THEME_CSS`) MUST be able to change any
  token or add rules without a rebuild.
- **FR-UI-4** — The app MUST NOT introduce a component library (no shadcn,
  Radix, MUI). Small hand-written primitives only.
- **FR-UI-5** — Status severity has a fixed three-step vocabulary — good /
  warning / critical — used consistently for anything with a real severity,
  and MUST NOT be used decoratively for anything without one.
- **FR-UI-6** — The UI MUST be usable at 375px width: tables reflow within
  their own container, the page body MUST NOT scroll horizontally, and tap
  targets MUST be touch-sized.
- **FR-UI-7** — Colour MUST NOT be the *sole* carrier of meaning — every
  severity state also has a text or glyph indicator.
- **FR-UI-8** — The app MUST meet WCAG AA contrast in the shipped theme.
  `--sq-dim` is the lowest-contrast text token and MUST still meet AA.
- **FR-UI-9** — The app MUST work with JavaScript disabled to the extent of
  rendering the member's usage and title list read-only.
- **FR-UI-10** — There MUST be no external asset requests (no CDN fonts, no
  remote images) in the shipped default — the font stack is system fonts by
  design, and the shipped favicon is a local SVG.

## Acceptance criteria

- **Given** a fresh deployment with no `THEME_CSS` set, **when** the app
  loads, **then** it renders the Seerr-matched default (dark, or light if the OS prefers it) with no network
  request for fonts or images leaving the origin.
- **Given** `THEME_CSS` pointing at a file that retints `--sq-accent` and
  sets `--sq-titlebar-border`, **when** the page reloads,
  **then** both changes are visible with no rebuild.
- **Given** `THEME_CSS` unset or pointing at a missing file, **when**
  `/theme.css` is requested, **then** it 404s with an empty body and the
  page still renders the default theme correctly (a 404'd stylesheet link is
  a harmless no-op).
- **Given** a 375px viewport, **when** the title list renders, **then** the
  body does not scroll horizontally and every action is reachable.
- **Given** JS is disabled, **when** a member opens the app, **then** usage
  and titles still render.

## Edge cases & failure modes

- **`THEME_CSS` file deleted/unreadable after boot** — the route 404s on the
  next request; the page falls back to the default theme rather than
  erroring.
- **Monospace metrics in an override** — an override that restores a
  monospace UI eats table width faster than the sans-serif default; truncate
  with a tooltip rather than wrapping a table cell into three lines.
- **`caret-shape: block`** is Chromium-only; the thin-caret fallback
  elsewhere needs no workaround.
