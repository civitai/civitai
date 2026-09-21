// Per-`$type` wall-clock allowances for the App Blocks PASS-THROUGH arm.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: `maxBuzz` IS ONLY A BUZZ BOUND WHEN BUZZ TRACKS RUNTIME.
//
// The pass-through arm stamps `timeout = maxBuzz` seconds, and
// `createBlockCustomComfyStep` states the premise that makes that sound:
// "at `job.ExpireAt` the job is canceled and billed for measured runtime, so
// worst-case Buzz = ceil(timeout_s × 1)". That identity holds for a step billed
// by MEASURED RUNTIME at ~1 Buzz/GPU-second, which is the inline-Comfy case it
// was designed for and which the orchestrator cannot quote in advance.
//
// It does not hold for a step the orchestrator prices from a RATE CARD. A
// six-second `minimax-h3-comfy` clip is quoted 210 Buzz before it runs —
// 35 Buzz per second of OUTPUT video — and takes ~330 seconds of wall clock to
// produce. Buzz and seconds are decoupled by a factor of ~1.6, and in the
// direction that matters: the price is already fixed by the rate card, so
// killing the job at 250 seconds does not cap the spend at 250. It caps
// NOTHING. It only guarantees the viewer is billed for a clip they never
// receive.
//
// So for a rate-card-priced `$type` the timeout is not a spend control, and
// using `maxBuzz` for it is a wall-clock limit wearing a spend control's
// clothes. The spend control for those steps is the one the arm already
// applies: the orchestrator's own `whatif` quote, the `max(declared, quoted)`
// reservation, and the `buzzBudget` gate that runs against it.
//
// 🔴 THIS FILE IS ON THE SPEND PATH AND IS A CODE-REVIEWED TRUST ROOT, exactly
// like `orchestrator-denylist.ts`. It has no DB access and loads at import
// time. An entry here lets a block hold a worker for longer than its declared
// Buzz would otherwise buy, so adding one is a spend-safety review, not a
// config edit. Adding a `$type` requires, in the PR:
//   1. evidence the orchestrator QUOTES it (a `whatif` returning a finite
//      `cost.total` for a representative body) — if it cannot be quoted, its
//      price IS its runtime and `maxBuzz` is the correct timeout;
//   2. a measured wall clock for a realistic job, with the sample size;
//   3. a value with headroom over that measurement, under the cap below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The longest wall clock any pass-through step may be granted.
 *
 * Not a Buzz number — a worker-occupancy number. A step that needs longer than
 * this is not a step a third-party block should be holding a worker for; it
 * wants the async/webhook shape instead. Asserted over the table at load.
 */
export const PASS_THROUGH_TIMEOUT_MAX_SECONDS = 1800;

/**
 * `$type` → wall-clock seconds, for the rate-card-priced types only.
 *
 * Keys are compared case-INSENSITIVELY, matching `assertStepTypeAllowed`: the
 * submitted `$type` is app-controlled free text within its length cap, and two
 * guards over the same untrusted field disagreeing about case is how one of
 * them gets bypassed.
 *
 * `videoGen` — 900s. Measured over ten `minimax-h3-comfy` six-second clips
 * (`startedAt` → `completedAt`, queue excluded, 2026-09-21): 321.2 321.2 324.7
 * 326.6 326.9 331.1 334.4 339.3 351.5 357.2 — median 327.6, max 357.2. 900
 * leaves ~2.5x headroom over the slowest observed, which is deliberate: the
 * measurement is one engine at one duration, and the `$type` covers others.
 * Quoted by the orchestrator: a 6s clip returns `cost.total = 210` and a 4s
 * returns 140, so the price is fixed before the job starts and does not grow
 * with the clock.
 */
const TIMEOUT_SECONDS_BY_TYPE: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    videogen: 900,
  })
);

/**
 * The wall clock to grant a pass-through step, in seconds.
 *
 * Falls back to `maxBuzz` — today's behaviour, unchanged — for every `$type`
 * without an entry. That default is the conservative one: it keeps the
 * runtime-priced assumption wherever nobody has shown it false.
 */
export function passThroughTimeoutSeconds($type: string, maxBuzz: number): number {
  const listed = TIMEOUT_SECONDS_BY_TYPE[$type.toLowerCase()];
  if (listed === undefined) return maxBuzz;
  // A block that declared a LARGER ceiling than the table keeps it: `maxBuzz`
  // is still its own declared bound and this must never shorten a job below
  // what the caller asked for.
  return Math.max(listed, maxBuzz);
}

/** Every `$type` with an explicit allowance. Exported for the guard test. */
export const PASS_THROUGH_TIMED_TYPES: readonly string[] = Object.freeze(
  Object.keys(TIMEOUT_SECONDS_BY_TYPE)
);

/** The declared allowance for a listed `$type`. Exported for the guard test. */
export function declaredTimeoutFor($type: string): number | undefined {
  return TIMEOUT_SECONDS_BY_TYPE[$type.toLowerCase()];
}

// Load-time bounds. A table entry is a worker-occupancy grant, so a typo that
// multiplies one by ten should fail the boot rather than reach a worker.
for (const [type, seconds] of Object.entries(TIMEOUT_SECONDS_BY_TYPE)) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `pass-through timeout for '${type}' must be a positive integer, got ${seconds}`
    );
  }
  if (seconds > PASS_THROUGH_TIMEOUT_MAX_SECONDS) {
    throw new Error(
      `pass-through timeout for '${type}' (${seconds}s) exceeds ` +
        `PASS_THROUGH_TIMEOUT_MAX_SECONDS (${PASS_THROUGH_TIMEOUT_MAX_SECONDS}s)`
    );
  }
  if (type !== type.toLowerCase()) {
    throw new Error(
      `pass-through timeout key '${type}' must be lower-case for the case-insensitive lookup`
    );
  }
}
