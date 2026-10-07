/**
 * Shared types for the self-service deletion module (P2-4,
 * `wiki/Feature-06-Self-Service-Deletion.md`). This is the ONLY component in
 * the project that can permanently destroy media — every file in this
 * directory exists to make that destructive path defensible under review.
 * See this directory's other files for the split:
 *
 *   - `guards.ts`     — the extensible "is anyone watching this" guard set
 *                        (`FR-DEL-4`/`4a`/`4b`).
 *   - `authorize.ts`  — the pure per-title decision core
 *                        (`FR-DEL-1`/`2`/`3`/`14`, AGENTS.md rule 9).
 *   - `deletionStore.ts` — impure DB reads/writes: fresh claim/title state,
 *                        the `deletion` table, the local `claim.released`
 *                        change.
 *   - `arrActions.ts` / `seerrCleanup.ts` — write-capable upstream clients
 *                        (`FR-DEL-9`/`10`/`11`).
 *   - `plan.ts`       — read-only preview for the D-7 select/review screens
 *                        (steps 1-2). Writes NO audit rows.
 *   - `execute.ts`    — the step-3 confirm handler. The actual destructive
 *                        path; everything else in this directory supports it.
 *
 * **Nothing under `src/app/**` calls these yet** — building the API routes
 * that wire an authenticated request into this module is explicitly a later
 * wave (per the project's design: "Backend only. Build no UI"). Every public
 * function here takes a `DeletionActor` as a TRUSTED input — resolving that
 * trust boundary (via `@/lib/auth`'s `requireIdentity`/`requireOperator`,
 * never a client-supplied `isOperator` flag) is the future route handler's
 * job, not this module's. This module's own job is everything downstream of
 * that: re-deriving authorization from FRESH state regardless of what the
 * caller *asked* for (`FR-DEL-1`/`FR-DEL-14`).
 */

export type DeletionMode = 'delete_files' | 'release_claim';

/** Every literal `DeletionMode` value — the allowlist `isDeletionMode` checks against. */
export const DELETION_MODES: readonly DeletionMode[] = ['delete_files', 'release_claim'];

/**
 * `FR-DEL-15`'s runtime allowlist check. `DeletionRequestItem.requestedMode`
 * is TYPED as `DeletionMode`, but nothing upstream of this module (no route
 * exists yet, and none ever gets to assume this) actually guarantees a
 * caller's raw request body was validated before it got cast to that type —
 * a `JSON.parse(body) as DeletionRequestItem[]` at a future route boundary
 * is exactly how an arbitrary string reaches here despite the static type.
 * `authorize.ts`'s `deriveTitleAction` calls this as its very FIRST check,
 * before anything else, so an unrecognised mode can never reach the
 * destructive `delete_files` branch by falling through an `if (=== 'release_
 * claim') ... else` — see that file's header comment for why the bug this
 * guards against is the single most dangerous shape this module can take.
 */
export function isDeletionMode(value: unknown): value is DeletionMode {
  return value === 'delete_files' || value === 'release_claim';
}

/**
 * The identity actually performing the call. `isOperator` MUST be resolved
 * server-side by the caller — never taken from a client-supplied body field,
 * a header the client controls, or anything else the caller doesn't already
 * trust. This module trusts `isOperator` exactly as given; it has no way to
 * re-verify it (that verification already happened, or should have, before
 * this module is ever invoked).
 */
export interface DeletionActor {
  username: string;
  isOperator: boolean;
}

/** One title the caller is asking about — the requested MODE matters (see
 * `authorize.ts`'s header comment on why it is never decorative): it is what
 * lets a sole claimant's mistaken "release" attempt be correctly REFUSED
 * rather than silently upgraded into the delete they didn't ask for. */
export interface DeletionRequestItem {
  titleId: string;
  requestedMode: DeletionMode;
}
