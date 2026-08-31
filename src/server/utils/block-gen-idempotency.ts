import { randomUUID } from 'crypto';
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
 * numeric (colon-free), `appBlockId` is a real `apb_<ULID>` or one of the three
 * synthetic pre-approval ids `ephemeral-<slug>` / `page_local_<slug>` /
 * `pubreq_<ULID>` (all colon-free), and `idempotencyKey` is charset-
 * restricted to `^[A-Za-z0-9_-]{1,64}$` at the zod input (colon-free). So no two
 * distinct (user, app, key) triples can ever collide on the delimiter. (A colon
 * IS a safe delimiter here — this is an internal redis key, not the orchestrator
 * `externalId`, whose charset excludes it. See composeBlockExternalId.)
 */
function genIdemRedisKey(userId: number, appBlockId: string, idempotencyKey: string): string {
  return `${REDIS_SYS_KEYS.BLOCKS.GEN_IDEM}:${userId}:${appBlockId}:${idempotencyKey}`;
}

/**
 * Charset for a client idempotency key (BOTH the gen submit and the tip endpoint,
 * audit 🟢). Restricting to a UUID-ish alphabet at the zod input keeps control
 * chars / newlines / colons out of the orchestrator `externalId` and the tip
 * `externalTransactionId` derived from the key. The SDK mints `crypto.randomUUID()`
 * (36 chars, `[0-9a-f-]`) or an `idem-<base36>-<base36>-<base36>` fallback (~35) —
 * both match comfortably. The `{1,64}` bound keeps the composed externalId under
 * the orchestrator's REAL 128-char ceiling (see ORCHESTRATOR_EXTERNAL_ID_MAX).
 */
export const BLOCK_IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The orchestrator's ACTUAL `externalId` contract, read from the source of truth
 * `civitai-orchestration:src/Civitai.Orchestration.Grains.Abstractions/Workflows/
 * WorkflowTemplate.cs` (`[StringLength(128, MinimumLength = 1)]` +
 * `[RegularExpression("^[A-Za-z0-9_-]+$")]`). `ConsumerControllerBase` carries
 * `[ApiController]`, so a violation is an automatic **400 before the action body
 * runs** — not a truncation. Verified present in the deployed
 * `orchestration-api:v2.26.11` (added by orchestration `c023ed9dd`).
 *
 * 🔴 An earlier revision ASSUMED a 512 ceiling and a colon-delimited id; both were
 * wrong (colons are outside the charset), which would have 400'd every keyed block
 * generation submit. Do not reintroduce a delimiter outside `[A-Za-z0-9_-]`.
 *
 * NOTE the orchestrator additionally PREFIXES `${userId}-` server-side when it
 * stores the value, but validation runs on the RAW client field — so this ceiling
 * applies to what we send, pre-prefix.
 */
export const ORCHESTRATOR_EXTERNAL_ID_MAX = 128;
export const ORCHESTRATOR_EXTERNAL_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/** 2 fixed digits encode the appBlockId length, so it must be 1..99 chars. */
const APP_BLOCK_ID_MAX_FOR_ENCODING = 99;

/**
 * ORIGIN NAMESPACE PREFIXES. Every block externalId starts with exactly one of
 * these 3-char tags, and they differ at index 2 — so the CLIENT-key namespace and
 * the SERVER-MINTED namespace are DISJOINT BY CONSTRUCTION. That is what makes it
 * impossible for a server-minted id to collide with a client-supplied one (which
 * would otherwise silently fuse two logically-distinct generations onto one
 * orchestrator `(userId, externalId)` dedupe slot).
 */
const BLOCK_EXTERNAL_ID_PREFIX_CLIENT = 'blk';
const BLOCK_EXTERNAL_ID_PREFIX_SERVER = 'bls';

/**
 * The SINGLE gate every emitted externalId passes. Shared by the client-key
 * composer and the server minter so neither can drift from the orchestrator
 * contract (`^[A-Za-z0-9_-]+$`, ≤128, enforced by `[ApiController]` as a hard 400
 * BEFORE the action body runs — a violation is a rejected submit, not a
 * truncation).
 */
function assertOrchestratorExternalId(externalId: string): string {
  if (externalId.length > ORCHESTRATOR_EXTERNAL_ID_MAX) {
    throw new Error(
      `block externalId too long (${externalId.length} > ${ORCHESTRATOR_EXTERNAL_ID_MAX})`
    );
  }
  if (!ORCHESTRATOR_EXTERNAL_ID_REGEX.test(externalId)) {
    // The key is charset-bounded at the zod input; this catches an appBlockId
    // shape that ever strays outside the orchestrator alphabet.
    throw new Error('block externalId contains characters the orchestrator rejects');
  }
  return externalId;
}

/**
 * Compose the namespaced orchestrator `externalId` for a block generation submit
 * from a CLIENT-supplied idempotency key.
 *
 * Shape: `blk<NN><appBlockId><key>`, where `NN` is the zero-padded 2-digit length
 * of `appBlockId`. A DELIMITER cannot be used — the orchestrator charset is
 * `[A-Za-z0-9_-]` and BOTH components may legitimately contain `_` and `-`
 * (`apb_<26-ULID>`, and the three SYNTHETIC pre-approval shapes
 * `ephemeral-<slug>`, `page_local_<slug>`, `pubreq_<ULID>` — see
 * SYNTHETIC_APP_BLOCK_ID_PREFIXES in user-app-surface.service; keys are UUIDs).
 * The length prefix pins the split point instead, which is INJECTIVE: two inputs
 * colliding would need the same `NN` (⇒ same appBlockId length ⇒ same appBlockId
 * prefix ⇒ same key).
 *
 * LENGTH. The longest appBlockId shape is `page_local_<slug>` — 11 + a slug bounded
 * at 40 by dev-token.ts's `z.string().min(3).max(40)` = 51 chars (NOT
 * `ephemeral-<slug>`, which is 50). So the true worst case is
 * 3 + 2 + 51 + 64 (max key) = **120** ≤ 128 — headroom 8, not the 119 an earlier
 * revision of this comment claimed. Typical is 3 + 2 + 30 (`apb_<26-ULID>`) + 36
 * (UUID) = 71.
 *
 * Fails CLOSED (throws before any cap reservation → no money moves) on anything
 * the orchestrator would reject, so a violation can never be silently truncated
 * into a BROKEN `(userId, externalId)` dedupe.
 */
export function composeBlockExternalId(appBlockId: string, idempotencyKey: string): string {
  // 🔴 `typeof` FIRST. Without it a non-string (an absent claim typed as `string`
  // by an upstream cast) reaches `undefined.length` → `undefined < 1` and
  // `undefined > 99` are BOTH false, so the guard passes and `padStart` on
  // `String(undefined)` yields a 9-char pseudo-`NN` (`undefined`) — silently
  // breaking the length-prefix injectivity this whole scheme rests on.
  if (typeof appBlockId !== 'string' || typeof idempotencyKey !== 'string') {
    throw new Error('block externalId: appBlockId and idempotencyKey must be strings');
  }
  if (appBlockId.length < 1 || appBlockId.length > APP_BLOCK_ID_MAX_FOR_ENCODING) {
    throw new Error(
      `block externalId: appBlockId length ${appBlockId.length} outside 1..${APP_BLOCK_ID_MAX_FOR_ENCODING}`
    );
  }
  return assertOrchestratorExternalId(
    `${BLOCK_EXTERNAL_ID_PREFIX_CLIENT}${String(appBlockId.length).padStart(
      2,
      '0'
    )}${appBlockId}${idempotencyKey}`
  );
}

/**
 * Mint a SERVER-SIDE orchestrator `externalId` for a block generation submit that
 * carries NO client idempotency key (audit 🔴-1).
 *
 * WHY THIS EXISTS. `submitWorkflow` (services/orchestrator/workflows.ts) calls
 * `submitWorkflowWithRetry` with `maxAttempts = 3` and NO per-attempt timeout on
 * the real submit, and that wrapper's own doc is explicit that it adds no
 * idempotency key — "the CALLER must set `body.externalId`". So a 502/504 or a
 * dropped socket AFTER the orchestrator already created the workflow and charged
 * makes attempts 2 and 3 create a SECOND and THIRD workflow: up to 3 charges for
 * one user action. Threading `externalId` only when the CLIENT sends a key left
 * that wide open, because no shipped client sends one (the SDK has zero
 * occurrences; the live tipping block hand-rolls its POST). Minting one
 * server-side closes it for ALL block traffic regardless of client version.
 *
 * STABLE-ACROSS-ATTEMPTS / UNIQUE-PER-REQUEST. This is called ONCE per logical
 * submit, in the router, before the body is built — and `submitWorkflowWithRetry`
 * reuses that same body object on every attempt. So all 3 attempts present the
 * SAME id (⇒ the orchestrator's `(userId, externalId)` dedupe collapses them to
 * one workflow + one charge), while two genuinely different submits get different
 * UUIDs. NEVER call this per attempt — that reintroduces the exact bug.
 *
 * SHAPE: `bls<uuid>` — a FIXED 3 + 36 = 39 chars, entirely inside `[A-Za-z0-9_-]`.
 * Deliberately carries NO appBlockId: uniqueness comes wholly from the UUID, so
 * there is nothing to length-encode and the guard below can never trip (unlike the
 * client-key path, whose length depends on caller-supplied components). That
 * matters because this path is UNCONDITIONAL — a throw here would reject a
 * generation that works today.
 *
 * The `bls` tag makes this namespace disjoint from the client `blk` namespace, so
 * a server-minted id can never collide with a client-supplied one.
 */
export function mintServerBlockExternalId(): string {
  return assertOrchestratorExternalId(`${BLOCK_EXTERNAL_ID_PREFIX_SERVER}${randomUUID()}`);
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
