/**
 * The persistent app shell (P1-8 item 1): wordmark, a minimal nav strip, the
 * identity badge, and the light/dark toggle that already exists in
 * `@/components/theme/ThemeToggle`. Deliberately generic — per this task's
 * brief, "This shell will also host the admin dashboard later, so keep it
 * generic; don't bake in member-only assumptions" — `activeSection` comes
 * from `@/components/shell/nav`'s `Section` union and every page passes its
 * own. Server component (no `'use client'`): only `ThemeToggle` inside it is
 * interactive, so the shell itself renders fully with JavaScript disabled
 * (`FR-UI-9`).
 *
 * Colours come ONLY from the `--sq-*` tokens in `src/app/globals.css`
 * (`FR-UI-1`) — no hardcoded colour anywhere below. The header row wraps
 * (`flexWrap: 'wrap'`) rather than overflowing at 375px, and `main` is
 * `width: 100%` with `box-sizing: border-box` padding so nothing here ever
 * forces the page body to scroll horizontally (`FR-UI-6`).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Identity } from '@/lib/auth/identity';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { getThemeConfig } from '@/lib/theme/config';
import { IdentityBadge } from './IdentityBadge';
import { NAV_ITEMS, type Section } from './nav';

export function AppShell({
  identity,
  activeSection,
  children,
}: {
  identity: Identity;
  activeSection: Section;
  children: ReactNode;
}) {
  const { appName } = getThemeConfig();
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', width: '100%' }}>
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.75rem 1rem',
          background: 'var(--sq-titlebar-bg)',
          color: 'var(--sq-titlebar-fg)',
          borderBottom: 'var(--sq-border-width) solid var(--sq-pane-rule)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1.25rem' }}>
          <span className="sq-heading" style={{ fontWeight: 600, color: 'var(--sq-fg)' }}>
            {appName}
          </span>
          <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }} aria-label="sections">
            {NAV_ITEMS.filter((item) => !item.operatorOnly || identity.isOperator).map((item) => {
              const isActive = item.section === activeSection;
              return (
                <Link
                  key={item.section}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    padding: '0.5rem',
                    fontSize: '0.875rem',
                    textDecoration: isActive ? 'underline' : 'none',
                    color: isActive ? 'var(--sq-fg)' : 'var(--sq-muted)',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
          <IdentityBadge identity={identity} />
          <ThemeToggle />
        </div>
      </header>
      <main
        style={{
          flex: 1,
          width: '100%',
          maxWidth: '64rem',
          margin: '0 auto',
          padding: '1.5rem 1rem',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
        }}
      >
        {children}
      </main>
    </div>
  );
}
