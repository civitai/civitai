/**
 * Shared helpers for the audit ReDoS / catastrophic-backtracking perf guards
 * (audit-redos / audit-cjk-redos / audit-gate-perf).
 *
 * WHY THIS EXISTS — these suites used to assert an ABSOLUTE wall-clock budget
 * (`expect(ms).toBeLessThan(100)`) on a single regex call over a long input.
 * That couples the test to the CI/dev CPU: the SAME (correct, linear) code
 * measures ~15ms on a fast runner and ~300ms on a loaded/slow one, so the
 * 100ms threshold flaked PASS→FAIL purely on hardware — it asserted "this CPU
 * is fast", not "this regex is linear". (Confirmed empirically: `includesMinor`
 * over `'young '+'a'*N` measured 8.6/16/19/47/96ms at N=2k/4k/8k/16k/32k —
 * cleanly linear — but tripped a 100ms wall-clock at the top end on a loaded
 * box.)
 *
 * The REAL invariant these guards exist to protect is **asymptotic**: the fix
 * (bounded `{0,200}` gaps + zero-width word boundaries) made the audit regexes
 * O(n) instead of the O(n²)/exponential pre-fix cost (a single prod call burned
 * 11–84s of synchronous main-thread CPU — a user-triggerable DoS). A reintroduced
 * quadratic/exponential pre-filter is what must trip the guard.
 *
 * So we assert the asymptotic shape directly, hardware-independently:
 *
 *  1. `expectSubQuadraticScaling` — measure the op at a small input N and a
 *     larger input K·N; for O(n) the time ratio tracks K, for O(n²) it tracks
 *     K². We require the observed ratio to stay well under the quadratic
 *     expectation (with slack for fixed per-call overhead + timer noise). This
 *     ratio is a property of the ALGORITHM, not the clock speed, so it does not
 *     flake on slow hardware — yet a reintroduced O(n²) blows it on any box.
 *
 *  2. `ABSOLUTE_HANG_CEILING_MS` — a deliberately generous absolute backstop
 *     (multiple seconds) that catches a true multi-second hang on ANY runner
 *     without re-coupling to CPU speed. The pre-fix cost was 11–84s; even the
 *     slowest CI core completes the linear scan in well under this ceiling.
 *
 * Correctness (match results unchanged by the boundary/bound fix) is proven
 * separately by audit-matching-equivalence.test.ts; these helpers only guard
 * the COST.
 */
import { expect } from 'vitest';

/**
 * Generous absolute backstop for a single audit call on a pathological input.
 * The pre-fix catastrophic cost was 11–84 SECONDS; a correct linear scan is
 * single-/low-double-digit ms even on a slow, loaded runner. 5s sits orders of
 * magnitude below a real hang while staying immune to per-runner CPU variance
 * (so it never flakes), yet trips long before a reintroduced ReDoS could pin a
 * pod's event loop.
 */
export const ABSOLUTE_HANG_CEILING_MS = 5000;

/**
 * Absolute ceiling for a SINGLE audit call on the LARGE scaling input (default
 * largeN = 32k chars). Calibrated against the documented linear-vs-quadratic gap:
 * linear work measures ~100ms there (and stays well under a second even on a 5–10×
 * slower / heavily-contended runner), whereas the removed O(n²) cost was ~2800ms at
 * N≈24k → ~5000ms at 32k (bigger CJK inputs hit ~84s). 1500ms sits an order of
 * magnitude above linear-on-this-input yet far below the quadratic cost, so it
 * never flakes on CPU variance but trips hard on a reintroduced backtrack.
 */
export const LARGE_N_LINEAR_CEILING_MS = 1500;

/** Median wall-clock (ms) of `fn` over `samples` runs — robust to GC/scheduler blips. */
export function medianMs(fn: () => unknown, samples = 5): number {
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    fn();
    xs.push(performance.now() - start);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

/**
 * Assert that running `op(buildInput(n))` is LINEAR-ish in `n`, not the
 * O(n²)/exponential catastrophic-backtracking the audit fix removed.
 *
 * Two complementary, hardware-independent guards:
 *  1. PRIMARY — a single call on the large input (default `largeN = 32k chars`)
 *     must finish under `LARGE_N_LINEAR_CEILING_MS`. Calibrated with an
 *     order-of-magnitude margin over linear-on-this-input but far below the known
 *     quadratic cost, so it never flakes on CPU variance yet trips a real ReDoS.
 *  2. SECONDARY — the small→large time RATIO (op compared against itself, so a
 *     uniformly slower CPU cancels): O(n) tracks `factor`, O(n²) tracks `factor²`;
 *     we require it under `factor · quadraticGuard`. Skipped when either median is
 *     below the timer-noise floor (a tiny baseline makes the ratio unreliable —
 *     the absolute bound covers that regime).
 *
 * Defaults give baseN=8k → largeN=32k: linear ~25–100ms, the removed O(n²) ~5s.
 */
export function expectSubQuadraticScaling(
  label: string,
  buildInput: (n: number) => string,
  op: (input: string) => unknown,
  opts: { baseN?: number; factor?: number; quadraticGuard?: number } = {}
): void {
  const baseN = opts.baseN ?? 8000;
  const factor = opts.factor ?? 4;
  // For O(n) the ratio ≈ factor (=4); for O(n²) ≈ factor² (=16). The midpoint
  // `factor * quadraticGuard` (=4*2=8) cleanly separates them: a linear op stays
  // near 4, a quadratic op jumps to ~16. quadraticGuard=2 gives linear work 2×
  // slack for fixed per-call overhead + timer noise while still tripping O(n²).
  const quadraticGuard = opts.quadraticGuard ?? 2;
  const ratioCeiling = factor * quadraticGuard;

  const smallInput = buildInput(baseN);
  const largeInput = buildInput(baseN * factor);

  // Warm up so JIT/regex compilation isn't charged to the first timed sample.
  op(smallInput);
  op(largeInput);

  const smallMs = medianMs(() => op(smallInput));
  const largeMs = medianMs(() => op(largeInput));

  // PRIMARY guard — large-N absolute bound with a deliberately HUGE margin.
  //
  // The pre-fix code was O(n²)/exponential: the documented prod baseline was
  // ~2800ms at N≈24k (and up to ~84s on bigger CJK inputs). Linear work on the
  // large input here measures low-tens-of-ms; even a 10×-slower or heavily
  // contended runner keeps it well under a second. So a ceiling sitting an order
  // of magnitude above linear-on-this-input but far BELOW the known quadratic
  // cost cleanly separates the two on ANY hardware — unlike a tight (100ms) budget
  // with ~1× margin, which flaked on CPU variance. This is the load-bearing check.
  expect(
    largeMs,
    `${label}: a single call on the ${largeInput.length}-char input took ${largeMs.toFixed(1)}ms — ` +
      `linear work here is low-tens-of-ms even on a slow/loaded runner; this magnitude indicates ` +
      `the quadratic/exponential backtracking the audit fix removed (prod baseline was seconds).`
  ).toBeLessThan(LARGE_N_LINEAR_CEILING_MS);

  // SECONDARY guard — scaling RATIO, but ONLY when both medians are above the
  // timer-noise floor (otherwise a 2ms→32ms blip reads as a false 13× even though
  // 32ms is plainly still linear). When the baseline is noise-dominated the
  // absolute bound above already covers correctness, so we skip the ratio.
  const NOISE_FLOOR_MS = 8;
  if (smallMs < NOISE_FLOOR_MS || largeMs < NOISE_FLOOR_MS) return;

  const ratio = largeMs / smallMs;
  expect(
    ratio,
    `${label}: cost scaled ${ratio.toFixed(2)}× when input grew ${factor}× ` +
      `(${baseN}→${baseN * factor} chars: ${smallMs.toFixed(1)}ms→${largeMs.toFixed(1)}ms). ` +
      `Linear work tracks ${factor}×; a ratio ≥ ${ratioCeiling}× indicates quadratic/` +
      `exponential backtracking (the ReDoS the audit fix removed).`
  ).toBeLessThan(ratioCeiling);
}
