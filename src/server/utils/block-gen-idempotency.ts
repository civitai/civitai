import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * In-flight / replay idempotency guard for the App Blocks GENERATION submit
 * (`blocks.submitWorkflow` — both the txt2img and customComfy branches).
 *
 * WHY (audit 🔴-1): a generation submit RESERVES the viewer's per-user daily +
 * per-app Buzz cap and then SUBMITS to the orchestrator (a real Buzz charge). The
 * base slice threads a client `idempotencyKey → orchestrator externalId` and
 * relies on the orchestrator's own `(userId, externalId)` dedupe — but with NO
 * civitai-side guard, two CONCURRENT same-key submits (a double-click, or an SDK
 * auto-retry racing before the first submit reaches the orchestrator) can BOTH
 * miss that dedupe → TWO cap-reservations + TWO pipeline runs + TWO charges. This
 * adds the civitai-side `SET NX` claim that mirrors the tip idempotency layer:
 *
 *   claim  — SET NX an in-progress sentinel BEFORE the cap reservation.
 *            first caller wins → { state: 'acquired' }.
 *            key already holds a TERMINAL result → { state: 'replay', result }
 *            (the handler returns the CACHED snapshot verbatim — no re-reservation,
 *            no re-submit).
 *            key still in-progress (or a lost/garbage value) → { state: 'in_progress' }
 *            (the handler 409s so a live first attempt is never raced into a 2nd
 *            reservation + charge).
 *   finalize — overwrite the sentinel with the TERMINAL result (the returned
 *              `{ snapshot }`) so a later lost-response retry replays it. Called
 *              ONLY on a resolved orchestrator submit (the money-committed path).
 *              Best-effort (never perturbs an already-produced response).
 *   release  — delete the sentinel for a NON-committed outcome (a pre-reservation
 *              rejection, a cap/velocity reject that refunded, or a throw before a
 *              resolved submit) so a genuine retry with the same key can execute —
 *              NO money moved, so re-running is safe.
 *
 * FAIL-CLOSED: `claim` THROWS on a redis error (the caller maps it to a retryable
 * 503) — a money endpoint must not run its dedupe blind. Mirrors the fail-closed
 * cap reservation the guard sits in front of.
 *
 * PLACEMENT: the claim is taken BEFORE `reserveBlockBuzzSpend`/`reserveAppSpend`,
 * so a replay ALSO can't double-INCR the daily/per-app cap counters (which are
 * keyed on `(userId, day)` / `(appBlockId, day)`, not on the externalId) — closing
 * audit 🟡-2's "the Redis spend-CAP counters still INCR on a replay" gap. The
 * orchestrator `externalId` dedupe remains a SECOND defense layer for the cross-
 * process / post-TTL case this in-process claim can't cover.
 */

// Covers realistic lost-response / double-click / SDK-auto-retry windows without
// pinning a stuck in-progress marker for long if `finalize` is ever lost on a
// redis blip. Matches BLOCK_TIP_IDEM_TTL_SECONDS.
const BLOCK_GEN_IDEM_TTL_SECONDS = 10 * 60;
// Leading-space sentinel: never a valid JSON document, so a claim that reads it
// back is unambiguously "still in progress" (JSON.parse throws → in_progress).
const GEN_IDEM_IN_PROGRESS = ' in-progress';

/**
 * Compose the per-(user, app, key) redis key. INJECTIVE because: `userId` is
 * numeric (colon-free), `appBlockId` is a real `apb_<ULID>` or a synthetic
 * `ephemeral-<slug>` dev id (both colon-free), and `idempotencyKey` is charset-
 * restricted to `^[A-Za-z0-9_-]{1,200}$` at the zod input (colon-free). So no two
 * distinct (user, app, key) triples can ever collide on the delimiter.
 */
function genIdemRedisKey(userId: number, appBlockId: string, idempotencyKey: string): string {
  return `${REDIS_SYS_KEYS.BLOCKS.GEN_IDEM}:${userId}:${appBlockId}:${idempotencyKey}`;
}

/**
 * Charset for a client idempotency key (BOTH the gen submit and the tip endpoint,
 * audit 🟢). Restricting to a UUID-ish alphabet at the zod input keeps control
 * chars / newlines / colons out of the orchestrator `externalId` and the tip
 * `externalTransactionId` derived from the key. The SDK mints `crypto.randomUUID()`
 * (`[0-9a-f-]`) or an `idem-<base36>-<base36>` fallback — both match. The `{1,200}`
 * bound stops a key from bloating the redis key or pushing the composed externalId
 * past the orchestrator's accepted length (see ORCHESTRATOR_EXTERNAL_ID_MAX).
 */
export const BLOCK_IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Conservative assumed ceiling for the orchestrator `externalId` (audit 🟢). The
 * orchestrator dedupes on `(userId, externalId)` and PREFIXES `${userId}-` server-
 * side; this repo does not carry the orchestrator's exact column/index limit, so we
 * assume a typical indexed-varchar ceiling of 512. With a charset+length-bounded
 * key (≤200) and an `apb_<26-ULID>` appBlockId (~30 chars), the composed
 * `block:<appBlockId>:<key>` maxes ~237 chars + a ≤~12-char `userId-` prefix —
 * comfortably under. The guard documents the assumption and fails CLOSED (throws,
 * before any reservation → no money moves) if a future longer id/key approaches it.
 */
export const ORCHESTRATOR_EXTERNAL_ID_MAX = 512;

/**
 * Compose the namespaced orchestrator `externalId` for a block generation submit.
 * INJECTIVE under the input contract (colon-free numeric prefix boundary is the
 * orchestrator's `userId-`; `appBlockId` and the charset-restricted key are both
 * colon-free), so `block:<appBlockId>:<key>` can never self-collide across apps or
 * keys. Throws if the composed id would exceed the assumed orchestrator ceiling.
 */
export function composeBlockExternalId(appBlockId: string, idempotencyKey: string): string {
  const externalId = `block:${appBlockId}:${idempotencyKey}`;
  if (externalId.length > ORCHESTRATOR_EXTERNAL_ID_MAX) {
    // Defense-in-depth: unreachable given the zod length/charset bounds, but a
    // fail-closed assert beats silently sending an over-long id the orchestrator
    // might truncate (which would BREAK the `(userId, externalId)` dedupe).
    throw new Error(
      `block externalId too long (${externalId.length} > ${ORCHESTRATOR_EXTERNAL_ID_MAX})`
    );
  }
  return externalId;
}

export type BlockGenIdempotencyClaim<T> =
  | { state: 'acquired'; key: string }
  | { state: 'replay'; result: T }
  | { state: 'in_progress' };

/**
 * Atomically CLAIM the idempotency key for a generation submit. Fail-CLOSED
 * (throws) on a redis error so the caller returns a retryable 503 — a money
 * endpoint must not dedupe blind. See the module doc-comment for the state machine.
 *
 * @typeParam T the caller's terminal result shape (the `{ snapshot }` it returns);
 *   on `replay` the cached value is returned typed as `T` (the caller owns the
 *   contract that `finalize` only ever stored a `T`).
 */
export async function claimGenIdempotency<T = unknown>(
  userId: number,
  appBlockId: string,
  idempotencyKey: string
): Promise<BlockGenIdempotencyClaim<T>> {
  const key = genIdemRedisKey(userId, appBlockId, idempotencyKey);
  // SET NX EX — first writer wins the in-progress sentinel. node-redis returns
  // 'OK' on set, null when the key already exists. (`key as never`: the composed
  // key is a valid runtime redis key; the sysRedis client's typed-key union doesn't
  // model the dynamic `${user}:${app}:${key}` suffix — same cast the sibling
  // block-tip-rate-limit helper uses on the cache client.)
  const claimed = await sysRedis.set(key as never, GEN_IDEM_IN_PROGRESS, {
    NX: true,
    EX: BLOCK_GEN_IDEM_TTL_SECONDS,
  });
  if (claimed) return { state: 'acquired', key };

  // Key already exists — read it to decide replay vs still-in-progress.
  const existing = await sysRedis.get(key as never);
  if (existing == null || existing === GEN_IDEM_IN_PROGRESS) {
    // Still running (or a set→get race where the winner hasn't finalized yet).
    // 409 rather than proceed — never race a live first attempt into a 2nd
    // reservation + charge.
    return { state: 'in_progress' };
  }
  try {
    const parsed = JSON.parse(existing) as { result?: unknown };
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      return { state: 'replay', result: parsed.result as T };
    }
  } catch {
    /* fall through — a malformed value is treated as in-progress (do NOT re-run) */
  }
  return { state: 'in_progress' };
}

/**
 * Persist the TERMINAL result (the returned `{ snapshot }`) of the FIRST resolved
 * submit so a later lost-response retry replays it. Best-effort: if the record
 * can't be written, the in-progress sentinel simply expires and a post-TTL retry
 * may re-run — where the orchestrator `externalId` dedupe is the second defense.
 * Never throws into an already-produced response.
 */
export async function finalizeGenIdempotency(key: string, result: unknown): Promise<void> {
  try {
    await sysRedis.set(key as never, JSON.stringify({ result }), {
      EX: BLOCK_GEN_IDEM_TTL_SECONDS,
    });
  } catch {
    /* best-effort — see doc comment */
  }
}

/**
 * Release the idempotency claim for a NON-committed outcome (a pre-reservation
 * rejection, a cap/velocity reject that already refunded, or a throw before a
 * resolved submit) so a genuine retry with the same key can execute. Safe because
 * NO money moved and NO reservation stands. Best-effort; never throws.
 */
export async function releaseGenIdempotency(key: string): Promise<void> {
  await sysRedis.del(key as never).catch(() => {
    /* best-effort — a stuck sentinel just 409s a retry until its short TTL */
  });
}
