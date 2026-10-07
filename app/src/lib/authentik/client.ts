/**
 * Read-only Authentik REST client — `wiki/Feature-02-Account-Sync.md`
 * "Interactions". Built on the shared `src/lib/http/client.ts`
 * (`UpstreamClient` + `bearerAuth`), exactly like `src/lib/seerr/client.ts` /
 * `src/lib/library/radarr.ts` do for their upstreams.
 *
 * **Authentik is read-only to this app, without exception (`FR-SYNC-7`).**
 * That is made STRUCTURALLY true here, not just by convention: `AuthentikClient`
 * below exposes exactly three public methods, every one of them a bare `GET`
 * (`this.http.request(path, { query })`, never passing `method:` at all, so
 * the default in `UpstreamRequestOptions` — `'GET'` — is always what's sent).
 * There is no method on this class, public or private, that issues a
 * POST/PUT/PATCH/DELETE. `test/authentik-client.test.ts` pins the exact
 * method set on the prototype so a future edit can't quietly add a write path
 * without a test failing. Authentik itself also enforces this at the RBAC
 * layer (the dedicated service-account user this app's token is minted for
 * holds only three global `view_*` permissions, nothing else) — this file is
 * the second, independent guarantee, not the only one.
 *
 * **The trap this file exists to avoid:**
 * `GET /core/applications/?slug=jellyseerr` (the list-with-filter form) is
 * unreliable for a non-superuser identity — observed to return an empty
 * result once and the WRONG application (`ldap`, not `jellyseerr`) on a
 * second identical call, because the list endpoint silently filters to
 * "applications the calling identity may currently launch" rather than
 * applying the `slug` filter as a plain lookup. `getApplicationBySlug` below
 * uses the **detail-by-slug** form instead (`GET /core/applications/{slug}/`),
 * which is deterministic and does not require `superuser_full_list=true`.
 */
import { bearerAuth, UpstreamClient, UpstreamError } from '../http/client';

const UPSTREAM_NAME = 'authentik';
const APPLICATION_PATH_PREFIX = '/api/v3/core/applications/';
const BINDINGS_PATH = '/api/v3/policies/bindings/';
const USERS_PATH = '/api/v3/core/users/';

/**
 * A `page_size` comfortably larger than any household-scale fleet of active
 * users, so a single page is the common case. `listAllPages` below still
 * follows Authentik's pagination defensively in case a future fleet exceeds
 * this in one page — never assumed to be exhaustive on faith alone.
 */
const PAGE_SIZE = 200;

/** Safety cap on the pagination loop, matching `src/lib/seerr/client.ts`'s `MAX_PAGES` — defends against a pathological/looping `pagination.next`, not a normal (currently 10-binding, 15-user) fleet. */
const MAX_PAGES = 100;

export interface AuthentikApplication {
  /** Authentik's `pk` for an application is itself the stable UUID (e.g. `"pk":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001"`). */
  uuid: string;
  slug: string;
  name: string;
}

/** The binding's embedded `user_obj` — has username/name/email/is_active but NOT the stable `uuid` (only `/core/users/` has that; join on `pk`). */
export interface AuthentikBindingUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  isActive: boolean;
}

export interface AuthentikPolicyBinding {
  pk: string;
  /** Integer Authentik user id, or `null` for a group/policy-type binding. A fleet may be entirely user-type bindings ("no group-based grant to chase") — `null` is handled defensively, not assumed impossible. */
  user: number | null;
  group: string | null;
  enabled: boolean;
  negate: boolean;
  userObj: AuthentikBindingUser | null;
}

/**
 * `GET /core/users/?is_active=true` row — carries the stable `uuid` the
 * binding's `user_obj` lacks, AND (`GET /core/users/?username=admin` returns
 * both `groups` — group UUIDs — and `groups_obj` — full group objects including `name`,
 * e.g. `groups_obj: [{..., name: "admins"}]` for `admin`) the group
 * membership `member.is_operator` needs. `groupNames` is read from
 * `groups_obj[].name` — the UUIDs in the bare `groups` array aren't useful
 * here since `src/lib/auth/identity.ts`'s `isInAdminGroup` (the SAME
 * function this app's request-time SSO gate uses, imported rather than
 * reimplemented — see `src/lib/authentik/identity.ts`) compares group
 * NAMES against `ADMIN_GROUP`, matching how Authentik's `Remote-Groups`
 * forward-auth header is also names, not UUIDs.
 */
export interface AuthentikUser {
  pk: number;
  uuid: string;
  username: string;
  name: string;
  email: string;
  isActive: boolean;
  groupNames: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidResponse(path: string, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', path, `${path} ${reason}`);
}

function parseApplication(raw: unknown, path: string): AuthentikApplication {
  const a = asRecord(raw);
  if (!a) invalidResponse(path, 'is not an object');
  if (typeof a.pk !== 'string') invalidResponse(path, 'is missing a string pk (application uuid)');
  if (typeof a.slug !== 'string') invalidResponse(path, 'is missing a slug');
  return { uuid: a.pk, slug: a.slug, name: typeof a.name === 'string' ? a.name : a.slug };
}

function parseBindingUser(raw: unknown): AuthentikBindingUser | null {
  const u = asRecord(raw);
  if (!u) return null;
  if (typeof u.pk !== 'number' || typeof u.username !== 'string') return null;
  return {
    pk: u.pk,
    username: u.username,
    name: typeof u.name === 'string' ? u.name : u.username,
    email: typeof u.email === 'string' ? u.email : '',
    isActive: u.is_active === true,
  };
}

function parseBinding(raw: unknown, index: number): AuthentikPolicyBinding {
  const b = asRecord(raw);
  if (!b) invalidResponse(BINDINGS_PATH, `binding[${index}] is not an object`);
  if (typeof b.pk !== 'string') invalidResponse(BINDINGS_PATH, `binding[${index}] is missing a string pk`);
  return {
    pk: b.pk,
    user: typeof b.user === 'number' ? b.user : null,
    group: typeof b.group === 'string' ? b.group : null,
    enabled: b.enabled === true,
    negate: b.negate === true,
    userObj: parseBindingUser(b.user_obj),
  };
}

/** `groups_obj` is an array of `{pk, name, ...}`. Tolerant: a missing/malformed entry is skipped rather than rejecting the whole user row — group membership is used for an ADDITIVE privilege (operator status), so under-reporting groups fails safe, over-reporting would not. */
function parseGroupNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    const g = asRecord(entry);
    if (g && typeof g.name === 'string') names.push(g.name);
  }
  return names;
}

function parseUser(raw: unknown, index: number): AuthentikUser {
  const u = asRecord(raw);
  if (!u) invalidResponse(USERS_PATH, `user[${index}] is not an object`);
  if (typeof u.pk !== 'number') invalidResponse(USERS_PATH, `user[${index}] is missing a numeric pk`);
  if (typeof u.uuid !== 'string') invalidResponse(USERS_PATH, `user[${index}] (pk=${u.pk}) is missing a uuid`);
  if (typeof u.username !== 'string') invalidResponse(USERS_PATH, `user[${index}] (pk=${u.pk}) is missing a username`);
  return {
    pk: u.pk,
    uuid: u.uuid,
    username: u.username,
    name: typeof u.name === 'string' ? u.name : u.username,
    email: typeof u.email === 'string' ? u.email : '',
    isActive: u.is_active === true,
    groupNames: parseGroupNames(u.groups_obj),
  };
}

/**
 * Authentik's list envelope is `{ pagination: {...}, results: [...] }`
 * (as seen in the broken-list-endpoint example above:
 * `{"pagination":{"count":1},"results":[]}`). Authentik's `pagination.next`
 * is a PAGE NUMBER, not a URL — `0` means "no next page" (a documented
 * Authentik API quirk, distinct from DRF's usual `next: null`). A missing or
 * malformed `pagination` block is treated as "this is the only page" rather
 * than looping — defensive, not a guess that more data exists.
 */
function parseListEnvelope(raw: unknown, path: string): { results: unknown[]; hasNext: boolean } {
  const data = asRecord(raw);
  if (!data || !Array.isArray(data.results)) {
    invalidResponse(path, 'did not return {results: [...]}');
  }
  const pagination = asRecord(data.pagination);
  const nextPage = pagination && typeof pagination.next === 'number' ? pagination.next : 0;
  return { results: data.results, hasNext: nextPage > 0 };
}

/**
 * Module-level (not a class method) so `AuthentikClient`'s prototype exposes
 * ONLY the three public GET methods below — a structural test
 * (`test/authentik-client.test.ts`) enumerates `AuthentikClient.prototype`'s
 * own property names and pins that exact set. A `private` class method would
 * still show up in that enumeration (TypeScript's `private` is a
 * compile-time check only, not a runtime-hidden member), which would
 * undermine the very guarantee this file's header comment claims.
 */
async function listAllPages<T>(
  http: UpstreamClient,
  path: string,
  query: Record<string, string | number | boolean>,
  parseItem: (raw: unknown, index: number) => T,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await http.request<unknown>(path, { query: { ...query, page, page_size: PAGE_SIZE } });
    const { results, hasNext } = parseListEnvelope(data, path);
    out.push(...results.map((raw, index) => parseItem(raw, index)));
    if (!hasNext || results.length === 0) break;
  }
  return out;
}

export class AuthentikClient {
  constructor(private readonly http: UpstreamClient) {}

  /**
   * `GET /api/v3/core/applications/{slug}/` — detail-by-slug, the ONLY
   * reliable way to resolve an application's UUID from this client. Do not
   * add a `listApplications`/`?slug=` method next to this one
   * — that endpoint is the documented trap this file exists to avoid.
   */
  async getApplicationBySlug(slug: string): Promise<AuthentikApplication> {
    const path = `${APPLICATION_PATH_PREFIX}${encodeURIComponent(slug)}/`;
    const data = await this.http.request<unknown>(path);
    return parseApplication(data, path);
  }

  /** `GET /policies/bindings/?target=<uuid>` — the entitled-user set for one application target. */
  async listPolicyBindingsForTarget(targetUuid: string): Promise<AuthentikPolicyBinding[]> {
    return listAllPages(this.http, BINDINGS_PATH, { target: targetUuid }, parseBinding);
  }

  /** `GET /core/users/?is_active=true` — bulk join source for the stable `uuid` per `pk`, one call rather than N+1. */
  async listActiveUsers(): Promise<AuthentikUser[]> {
    return listAllPages(this.http, USERS_PATH, { is_active: true }, parseUser);
  }
}

/** Builds an `AuthentikClient` wired to `AUTHENTIK_URL`/`AUTHENTIK_TOKEN` (`wiki/Configuration.md`). Bearer auth — Authentik's token scheme. */
export function createAuthentikClient(baseUrl: string, token: string, timeoutMs: number, retries: number): AuthentikClient {
  return new AuthentikClient(new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: bearerAuth(token), timeoutMs, retries }));
}
