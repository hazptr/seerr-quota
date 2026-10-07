/**
 * `POST /api/deletion/schedule` — the preferred name for what the confirm
 * screen does (`FR-DEL-22`): schedule a deletion, don't perform one.
 *
 * Deliberately a thin re-export of `/api/deletion/execute`'s handler rather
 * than a copy. Two routes that both take a destructive request and are
 * *supposed* to behave identically are exactly the pair that drifts, and the
 * one that drifts is the one nobody is testing. There is one handler; this
 * path is an alias for it, kept so new clients can use an honest verb while
 * `/execute` stays valid for anything already pointed at it.
 */
export { POST, runtime, dynamic } from '../execute/route';
