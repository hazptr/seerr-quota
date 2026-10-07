import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getThemeConfig } from '@/lib/theme/config';
import { APP_VERSION } from '@/lib/version';

const theme = getThemeConfig();

export const metadata: Metadata = {
  title: theme.appName,
  description: 'Per-user disk quota, self-service cleanup, and audit sidecar for Seerr.',
  // `FAVICON_URL` (default `/favicon.svg`, shipped in `public/`, a neutral
  // mark — wiki/Theming.md "Env vars"). A deployment that wants its own icon
  // points this at whatever its own reverse proxy serves.
  icons: {
    icon: [{ url: theme.faviconUrl }],
  },
};

// Without this, mobile browsers lay the page out at a desktop-width virtual
// viewport (~980px) and scale the whole thing down to fit — every `overflow-x:
// auto` table and `flexWrap` header below becomes moot because the "375px
// viewport" they're written for never actually exists on the device.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Inline, synchronous script at the very top of `<head>` — runs before the
 * browser paints anything, so an explicit `data-theme` choice never flashes
 * the wrong palette first. Reads the same `localStorage` key
 * (`ThemeToggle`'s `THEME_STORAGE_KEY`) that the toggle writes; the two must
 * agree or they'd fight each other. `suppressHydrationWarning` on `<html>`
 * tells React the attribute is intentionally set outside its render (by this
 * script), not a real mismatch.
 *
 * Absent/invalid stored value -> no `data-theme` attribute at all -> the
 * default (dark) theme in `globals.css` applies — see wiki/Theming.md
 * "Light variant" for why no `prefers-color-scheme: light` block ships by
 * default.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('seerr-quota-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/*
         * Runtime theme override (`THEME_CSS` — wiki/Theming.md "Env vars").
         * Linked AFTER `globals.css` (imported above, inlined by Next into
         * the page's own stylesheet) so any `--sq-*` token or rule here wins
         * via normal cascade order — no `!important` needed. `/theme.css`
         * 404s with an empty body when `THEME_CSS` is unset, which is a
         * harmless no-op `<link>`.
         */}
        {/* eslint-disable-next-line @next/next/no-css-tags -- deliberate: a runtime (not build-time) override, so next/head's CSS-import optimization doesn't apply */}
        <link rel="stylesheet" href="/theme.css" />
      </head>
      <body>
        {children}
        <footer className="sq-footer">
          {theme.appName} v{APP_VERSION}
        </footer>
      </body>
    </html>
  );
}
