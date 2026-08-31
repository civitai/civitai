import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  AUTO_RETRY_BACKOFF_MS,
  BLOCK_READY_TIMEOUT_MS,
  MAX_AUTO_REMINTS,
  MAX_AUTO_RETRIES,
  TOKEN_WAIT_TIMEOUT_MS,
  worstReachableLaunchMs,
} from '../pageBlockHostLogic';
import { MAX_LAUNCH_SAMPLE_MS } from '../launchTimings';
import { MAX_APP_BLOCK_LAUNCH_SECONDS } from '~/server/metrics/app-block-runtime.metrics';

/**
 * 🔴 THE LAUNCH-SAMPLE CAP MUST CLEAR THE AUTO-RETRY BOUND — DERIVED, NOT ASSERTED.
 *
 * The launch histograms DROP any sample past a fixed cap. If that cap is below
 * the longest legitimate success, it silently discards real slow launches, and
 * the discard is slowness-correlated: it trims exactly the tail the metric exists
 * to show, in the flattering direction.
 *
 * This has already gone wrong twice, both times in a COMMENT that nothing checked:
 *   - a 30s cap justified by "TOKEN_WAIT_TIMEOUT_MS (15s) is the longest leg",
 *     which assumed a launch is one attempt — it is not, the host emits one `ok`
 *     for the whole bounded sequence;
 *   - a "~47s" bound derived from two consecutive `no_token`s, which
 *     `MAX_AUTO_REMINTS = 1` makes unreachable.
 *
 * So the bound is computed from the five constants that actually govern it, and
 * both caps are asserted against it. Widening any of them walks the bound up and
 * turns this red, instead of quietly invalidating a comment.
 */
describe('launch-sample cap vs the auto-retry bound', () => {
  it('🔴 both caps exceed the worst reachable successful launch', () => {
    const worst = worstReachableLaunchMs();
    expect(MAX_LAUNCH_SAMPLE_MS).toBeGreaterThan(worst);
    expect(MAX_APP_BLOCK_LAUNCH_SECONDS * 1000).toBeGreaterThan(worst);
  });

  it('🔴 the client and server caps agree (a split would drop samples on one side only)', () => {
    expect(MAX_LAUNCH_SAMPLE_MS).toBe(MAX_APP_BLOCK_LAUNCH_SECONDS * 1000);
  });

  /**
   * Recomputes the bound INDEPENDENTLY of `worstReachableLaunchMs`, from the raw
   * constants, so the two can disagree. Deriving the expectation from the
   * implementation would make this a tautology.
   */
  it('🔴 the bound matches an independent recomputation from the raw constants', () => {
    const backoffs = AUTO_RETRY_BACKOFF_MS.slice(0, MAX_AUTO_RETRIES).reduce((a, b) => a + b, 0);
    // attempt 1: no token at all -> `no_token` at the token timeout (auth
    // terminal, spends the single re-mint).
    // attempt 2: a re-mint is in flight, so the token wait can be paid AGAIN, and
    //   the ready timer only arms once a token exists -> the two windows are
    //   SERIAL within this attempt -> `timeout` (non-auth, spends no re-mint).
    // attempt 3: the token from attempt 2 persists, so this attempt is bounded by
    //   the ready timeout alone, and ends in `ok`.
    const independent =
      TOKEN_WAIT_TIMEOUT_MS +
      (TOKEN_WAIT_TIMEOUT_MS + BLOCK_READY_TIMEOUT_MS) +
      Math.max(0, MAX_AUTO_RETRIES - MAX_AUTO_REMINTS) * BLOCK_READY_TIMEOUT_MS +
      backoffs;

    expect(worstReachableLaunchMs()).toBe(independent);
    // Value pin on today's constants, so a silent constant change is visible in
    // the diff of this file rather than only in a derived comparison.
    expect(independent).toBe(57_000);
  });

  /**
   * 🔴 A NAIVE BOUND IS WRONG IN BOTH DIRECTIONS, and this pins why — the two
   * facts that make the arithmetic non-obvious are exactly the ones that were
   * missed. `3 x (token + ready) + backoffs` = 82s OVER-states it (two `no_token`s
   * are unreachable, and a post-`timeout` attempt already holds a token, so it
   * cannot re-pay the token wait). `attempts x token` = 37s UNDER-states it (an
   * attempt whose token arrives late pays BOTH windows serially).
   */
  it('sits strictly between the naive over- and under-estimates', () => {
    const backoffs = AUTO_RETRY_BACKOFF_MS.slice(0, MAX_AUTO_RETRIES).reduce((a, b) => a + b, 0);
    const attempts = MAX_AUTO_RETRIES + 1;
    const naiveOver = attempts * (TOKEN_WAIT_TIMEOUT_MS + BLOCK_READY_TIMEOUT_MS) + backoffs;
    const naiveUnder = attempts * TOKEN_WAIT_TIMEOUT_MS + backoffs;

    expect(worstReachableLaunchMs()).toBeLessThan(naiveOver);
    expect(worstReachableLaunchMs()).toBeGreaterThan(naiveUnder);
  });

  /**
   * The margin is genuinely tight (~3s on today's constants), so say so out loud
   * rather than letting "it passes" imply comfort. This is documentation with an
   * assertion attached: if someone pads the cap, the message here stops matching
   * and they will re-read the reasoning.
   */
  it('documents that the margin is thin, not comfortable', () => {
    const margin = MAX_LAUNCH_SAMPLE_MS - worstReachableLaunchMs();
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(10_000);
  });
});

/**
 * 🔴 SOURCE GATE — the first-mount seed must happen at RENDER time.
 *
 * `shouldResetLaunchMarks` is unit-tested and correct, but the AUDIT found its
 * WIRING is what actually carries the fix, and nothing pinned that: move the
 * `launchInstanceRef` seed out of render and into a `useEffect` and the predicate
 * stays correct, all three of its tests stay green, and the original bug — every
 * `total` short by the render->effect gap — returns verbatim.
 *
 * WHY A SOURCE GATE RATHER THAN A BROWSER SPY. A spy asserting `resetLaunchMarks`
 * is not called on first mount would be deterministic and magnitude-free, and it
 * would be the more direct test. But it can only live in the `component` project,
 * and that project IS NOT RUN IN CI — so it would be a guard that reports safety
 * in a tier which never observes it. This gate runs in `unit`, which CI does run.
 * The trade is real and worth naming: this checks the SHAPE of the source, not
 * the behaviour, so it can be defeated by a refactor that preserves neither.
 */
describe('PageBlockHost: launch-mark seed wiring', () => {
  const HOST = path.resolve(__dirname, '../PageBlockHost.tsx');

  /**
   * Collect the character ranges of every `useEffect(` call by brace-matching
   * from its opening paren. Deliberately not a regex over the whole file: a regex
   * cannot tell "inside an effect" from "textually after one".
   */
  function effectCallSpans(src: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const needle = 'useEffect(';
    let from = 0;
    for (;;) {
      const start = src.indexOf(needle, from);
      if (start === -1) break;
      let depth = 0;
      let i = start + needle.length - 1; // at the '('
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      spans.push([start, i]);
      from = start + needle.length;
    }
    return spans;
  }

  function seedIsAtRenderScope(src: string): boolean {
    const seed = src.indexOf('launchInstanceRef.current = blockInstanceId');
    if (seed === -1) return false;
    return !effectCallSpans(src).some(([a, b]) => seed > a && seed < b);
  }

  /**
   * 🔴 POSITIVE CONTROL FOR THE CHECKER ITSELF. Without this, a checker whose
   * brace-matching silently found nothing would report "at render scope" for any
   * input and this gate would be green while testing nothing.
   */
  it('the checker rejects a seed that has been moved into a useEffect', () => {
    const bad = `
      const launchInstanceRef = useRef(null);
      useEffect(() => {
        if (launchInstanceRef.current === null) launchInstanceRef.current = blockInstanceId;
      }, []);
    `;
    expect(seedIsAtRenderScope(bad)).toBe(false);

    const good = `
      const launchInstanceRef = useRef(null);
      if (launchInstanceRef.current === null) launchInstanceRef.current = blockInstanceId;
      useEffect(() => { doSomethingElse(); }, []);
    `;
    expect(seedIsAtRenderScope(good)).toBe(true);
  });

  it('🔴 the real host seeds launchInstanceRef at render scope, not inside an effect', () => {
    const src = fs.readFileSync(HOST, 'utf8');
    // Guard the guard: if the symbol is ever renamed, fail loudly rather than
    // passing vacuously on a file that no longer contains it.
    expect(src).toContain('launchInstanceRef');
    expect(seedIsAtRenderScope(src)).toBe(true);
  });

  it('the host re-arms the marks through the predicate, not unconditionally', () => {
    const src = fs.readFileSync(HOST, 'utf8');
    expect(src).toContain('shouldResetLaunchMarks(launchInstanceRef.current, blockInstanceId)');
  });
});
