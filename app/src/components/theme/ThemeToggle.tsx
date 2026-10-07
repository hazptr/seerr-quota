'use client';

/**
 * Explicit light/dark override (FR-UI-2), persisted per browser via
 * `localStorage`. Cycles system → light → dark → system, writing the
 * `data-theme` attribute on `<html>` that `src/app/globals.css`'s
 * `:root[data-theme="dark"]` / `:root[data-theme="light"]` rules key off —
 * NOT a `.dark` class (unlike a Tailwind `class` strategy, which some apps use
 * Tailwind's class strategy); the attribute is what
 * wiki/Theming.md's tokens spec, and what
 * `src/app/layout.tsx`'s no-flash init script sets before first paint.
 *
 * `THEME_STORAGE_KEY` and the tri-state cycle are shared with that init
 * script's inline copy — the two must agree or the toggle would fight the
 * initial paint.
 */
import { useEffect, useState } from 'react';

export const THEME_STORAGE_KEY = 'seerr-quota-theme';

type ThemePreference = 'system' | 'light' | 'dark';

function nextPreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') setPref(stored);
    } catch {
      // localStorage unavailable (private mode, disabled) — fall back to system, silently.
    }
  }, []);

  function cycle() {
    const next = nextPreference(pref);
    setPref(next);
    applyTheme(next);
    try {
      if (next === 'system') {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Non-fatal — the in-memory toggle still works for this page view.
    }
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${pref} (click to change)`}
      style={{
        background: 'transparent',
        border: 'var(--sq-border-width) solid var(--sq-pane-rule)',
        color: 'var(--sq-muted)',
        fontFamily: 'var(--sq-font)',
        fontSize: '0.75rem',
        padding: '0.25rem 0.5rem',
        cursor: 'pointer',
      }}
    >
      theme: {pref}
    </button>
  );
}
