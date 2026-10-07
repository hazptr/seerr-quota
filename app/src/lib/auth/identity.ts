/**
 * Pure identity-resolution logic for Feature 1 (SSO & Identity,
 * wiki/Feature-01-SSO-Identity.md, FR-SSO-2/3/4). No I/O, no Next.js imports:
 * takes the raw forward-auth header values (whatever a reverse proxy's —
 * e.g. SWAG, Traefik — forward-auth location injects for the IdP in front of
 * it: Authentik, Authelia, oauth2-proxy, Pomerium, ... see the wiki's
 * "Interactions" nginx snippet and `examples/forward-auth/`) plus the
 * configured operator allowlist/group, and returns a typed `Identity` or
 * `null`. The impure shells — `src/middleware.ts` (the gate) and
 * `src/lib/auth/session.ts` (the per-request re-read for pages/routes) —
 * both call this same function, so there is exactly one implementation of
 * "what do these headers mean" (AGENTS.md rule 9, pure core / impure shell).
 *
 * This module has no alternate identity source (no cookie, no query param)
 * — the configured username/groups headers (`AUTH_USER_HEADER`/
 * `AUTH_GROUPS_HEADER`, default `Remote-User`/`Remote-Groups` — the HEADER
 * NAMES are resolved by the caller from `getConfig().identity`, not by this
 * module) are the ONLY inputs it ever reads (FR-SSO-4: the app must not
 * treat anything else as authoritative). The actual anti-spoofing boundary
 * is outside this app entirely: the reverse proxy's forward-auth location
 * block unconditionally overwrites any client-sent copy of these headers
 * before proxying (wiki/Feature-01-SSO-Identity.md "Interactions"; the proxy
 * MUST do this on every request, whichever IdP sits behind it), and the
 * container's loopback-only bind stops the LAN from reaching the app around
 * that gate.
 * This module — and every caller of it — has no way to distinguish a
 * reverse-proxy-authored header from a spoofed one; it isn't supposed to. Its only
 * job is to not add a SECOND, weaker path to the same trust decision.
 *
 * Edge cases from wiki/Feature-01-SSO-Identity.md "Edge cases & failure
 * modes" (hand-calculated in app/test/auth-identity.test.ts):
 *   - Missing/blank `Remote-User` -> `null` (never crash) — callers turn this
 *     into a 401 (FR-SSO-2).
 *   - Missing/empty `Remote-Groups` -> `[]` (member, no extra groups), not a
 *     crash.
 *   - `Remote-Groups` splits on BOTH `|` and `,` (FR-SSO-3), in any mixture.
 *   - Username casing: "Authentik usernames are lowercase by convention
 *     here; normalise to lowercase for all comparisons and storage, but keep
 *     the raw header value for display." `Identity.username` is the
 *     lowercased, canonical value (what every comparison, DB lookup against
 *     `member.sso_username`, and audit `actor` field must use);
 *     `Identity.displayUsername` is the trimmed-but-not-lowercased raw value,
 *     for UI display only — never compare or look anything up by it.
 *   - Operator status (FR-SSO-3): username case-insensitively in
 *     `ADMIN_USERS`, OR `Remote-Groups` case-insensitively includes
 *     `ADMIN_GROUP`. Either one is sufficient.
 */

export interface Identity {
  /** Lowercased `Remote-User` — the canonical id for every comparison, `member.sso_username` lookup, and audit `actor` field. */
  username: string;
  /** `Remote-User` exactly as sent (trimmed only) — casing preserved, DISPLAY ONLY. Never compare or look up by this. */
  displayUsername: string;
  /** Parsed `Remote-Groups`: split on both `|` and `,`, trimmed, empty entries dropped. */
  groups: string[];
  /** True iff `username` case-insensitively matches an `ADMIN_USERS` entry, or `groups` case-insensitively includes `ADMIN_GROUP` (FR-SSO-3). */
  isOperator: boolean;
}

/**
 * Splits a raw `Remote-Groups` header value on `|` and/or `,` (FR-SSO-3, any
 * mixture of the two), trims each entry, and drops empties. `undefined`/
 * `null`/`''` all yield `[]` — an absent header means "member with no
 * groups", never a throw.
 */
export function parseGroups(rawHeader: string | null | undefined): string[] {
  if (!rawHeader) return [];
  return rawHeader
    .split(/[|,]/)
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
}

/**
 * Case-insensitive membership check against the configured `ADMIN_USERS`
 * list (`Config.identity.adminUsers`). `usernameLower` must already be
 * lowercased (callers pass `Identity.username`, never `displayUsername`).
 */
export function isOperatorUser(usernameLower: string, adminUsers: readonly string[]): boolean {
  return adminUsers.some((admin) => admin.trim().toLowerCase() === usernameLower);
}

/**
 * Case-insensitive membership check against the configured `ADMIN_GROUP`
 * (`Config.identity.adminGroup`, default `admins`). An empty/whitespace-only
 * `adminGroup` never matches (there is no "no group required to be operator"
 * reading here — this isn't a gate
 * on who gets in, only on who's an operator; the empty case is defensive,
 * not a documented configuration).
 */
export function isInAdminGroup(groups: readonly string[], adminGroup: string): boolean {
  const needle = adminGroup.trim().toLowerCase();
  if (needle === '') return false;
  return groups.some((group) => group.toLowerCase() === needle);
}

/**
 * Resolves an `Identity` from the raw header values plus the configured
 * operator allowlist/group. Returns `null` when there is no usable
 * `Remote-User` (absent, or blank/whitespace-only after trimming) — callers
 * turn a `null` into a 401 (FR-SSO-2); this function itself never throws.
 */
export function resolveIdentity(
  rawUsername: string | null | undefined,
  rawGroups: string | null | undefined,
  adminUsers: readonly string[],
  adminGroup: string,
): Identity | null {
  const displayUsername = rawUsername?.trim() ?? '';
  if (displayUsername === '') return null;
  const username = displayUsername.toLowerCase();
  const groups = parseGroups(rawGroups);
  const isOperator = isOperatorUser(username, adminUsers) || isInAdminGroup(groups, adminGroup);
  return { username, displayUsername, groups, isOperator };
}
