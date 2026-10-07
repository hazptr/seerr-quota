/**
 * Shared "which section of the app am I in" vocabulary for the persistent
 * app shell (`AppShell.tsx`) — same idea used elsewhere in this project's
 * `components/shell/sections.ts`. P1-8 shipped one screen ("my usage"); P1-9
 * (`wiki/Backlog.md`, [[Feature-07-Admin-Dashboard]]) added `'admin'` here,
 * exactly the addition this file's own P1-8 header comment anticipated; P2-7
 * (`FR-AUD-10`) adds `'history'` the same way — `AppShell` takes
 * `activeSection`/`NAV_ITEMS` generically so each addition only touches this
 * list, never `AppShell.tsx` itself.
 */
export type Section = 'usage' | 'admin' | 'history';

export interface NavItem {
  href: string;
  label: string;
  section: Section;
  /** Hidden from a non-operator's nav (`AppShell` filters on this). Hiding the link is NOT the authorization boundary — `/admin`'s own server-side `requireOperator` check (`FR-ADM-1`) is; this only keeps a member from seeing a link that would 403. */
  operatorOnly?: boolean;
}

/** The persistent, top-billed nav items, in display order. `/history` (`FR-AUD-10`) is deliberately NOT `operatorOnly` — every identity, operator included, has their own audit history to see. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'my usage', section: 'usage' },
  { href: '/history', label: 'my history', section: 'history' },
  { href: '/admin', label: 'admin', section: 'admin', operatorOnly: true },
];
