import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  AUTO_RETRY_BACKOFF_MS,
  BLOCK_READY_TIMEOUT_MS,
  MAX_AUTO_REMINTS,
  MAX_AUTO_RETRIES,
  TOKEN_WAIT_TIMEOUT_MS,
  worstReachableInitPosts,
  worstReachableLaunchMs,
} from '../pageBlockHostLogic';
import {
  INIT_RETRY_BACKOFF_MS,
  INIT_RETRY_INTERVAL_MS,
  maxInitPostsWithin,
} from '../iframeInitController';
import { MAX_LAUNCH_INIT_POSTS, MAX_LAUNCH_SAMPLE_MS } from '../launchTimings';
import {
  MAX_APP_BLOCK_LAUNCH_INIT_POSTS,
  MAX_APP_BLOCK_LAUNCH_SECONDS,
} from '~/server/metrics/app-block-runtime.metrics';

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
 * 🔴 THE INIT-POST CAP MUST CLEAR THE SCHEDULE'S OWN REACH — same shape as the
 * duration cap above, same failure mode, one extra reason to care.
 *
 * `boundedInitPosts` / `launchInitPostsSample` DROP anything past the cap. If
 * the cap sits below what the re-post schedule can actually produce, the drop is
 * SIGNAL-CORRELATED in the worst possible direction: it discards precisely the
 * launches that posted the most, i.e. the quantization-bound ones the field was
 * added to detect. The metric would then report "launches ack on the first post"
 * by construction, and the cadence lever would be retired on evidence the cap
 * itself manufactured.
 *
 * 🔴 AND THE CAP IS COUPLED TO A KNOB PEOPLE WILL TUNE. `INIT_RETRY_BACKOFF_MS`
 * exists to be shortened; shortening it RAISES the reachable post count. A cap
 * picked by eye today is a cap that silently starts dropping samples the next
 * time anyone tunes the cadence — which is exactly the moment the metric is
 * being read. Deriving it is what makes that a red test instead.
 */
describe('init-post cap vs the re-post schedule', () => {
  it('🔴 both caps exceed the worst reachable post count', () => {
    const worst = worstReachableInitPosts();
    expect(MAX_LAUNCH_INIT_POSTS).toBeGreaterThan(worst);
    expect(MAX_APP_BLOCK_LAUNCH_INIT_POSTS).toBeGreaterThan(worst);
  });

  it('🔴 the client and server caps agree (a split would drop samples on one side only)', () => {
    expect(MAX_LAUNCH_INIT_POSTS).toBe(MAX_APP_BLOCK_LAUNCH_INIT_POSTS);
  });

  /**
   * Recomputes the bound INDEPENDENTLY of `worstReachableInitPosts`, by walking
   * the schedule by hand. Deriving the expectation from the implementation would
   * make this a tautology — the same trap the duration bound above documents.
   */
  it('🔴 the bound matches an independent walk of the schedule', () => {
    // Posts inside ONE attempt's readiness window: the immediate post at t=0,
    // then a post at each cumulative gap strictly before the window closes.
    let t = 0;
    let perAttempt = 1;
    for (let n = 0; ; n += 1) {
      t += INIT_RETRY_BACKOFF_MS[n] ?? INIT_RETRY_INTERVAL_MS;
      if (t >= BLOCK_READY_TIMEOUT_MS) break;
      perAttempt += 1;
    }
    // +1 per attempt for the at-most-once BLOCK_HELLO push; x attempts because
    // the launch marks are NOT reset by the auto-retry path, so posts accumulate
    // across every attempt of one launch.
    const independent = (MAX_AUTO_RETRIES + 1) * (perAttempt + 1);

    expect(worstReachableInitPosts()).toBe(independent);
    // Value pin on today's constants, so a silent schedule change shows up in
    // this file's diff rather than only in a derived comparison.
    // 28 = 1 immediate + 3 backoff (50/100/200 -> t=350) + 24 steady 400ms ticks
    // landing at t=750..9950, the last one strictly inside the 10s window.
    expect(perAttempt).toBe(28);
    expect(independent).toBe(87); // 3 attempts x (28 + 1 BLOCK_HELLO push)
  });

  /**
   * 🔴 THE DIRECTION CHECK. The whole hazard is a cap that stops clearing the
   * bound after someone shortens the cadence. Assert that shortening the front
   * of the schedule really does raise the count, so the guard above is known to
   * be sensitive to the knob it is protecting rather than merely true today.
   */
  it('a shorter front-loaded schedule raises the reachable count', () => {
    const withBackoff = maxInitPostsWithin(BLOCK_READY_TIMEOUT_MS, INIT_RETRY_BACKOFF_MS, 400);
    const flat = maxInitPostsWithin(BLOCK_READY_TIMEOUT_MS, [], 400);
    expect(withBackoff).toBeGreaterThan(flat);
    expect(withBackoff - flat).toBe(INIT_RETRY_BACKOFF_MS.length);
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

  /**
   * 🔴 THE POST COUNTER'S WIRING — the one part of `initPosts` that no pure test
   * can reach, and the part that decides whether the field means anything.
   *
   * `boundedInitPosts` and the histogram are both unit-tested, but they only
   * grade a number someone else produced. If the host never increments, every
   * one of those tests stays green and the beacon simply omits the field —
   * `computeLaunchTimings` drops a 0 by design — so the metric would report NO
   * DATA rather than wrong data. That is quiet in the worst way: the dashboard
   * would look like "launches carry no post count yet" rather than "the
   * instrument is broken".
   *
   * 🔴 AND THE INCREMENT MUST LIVE IN `sendInitOnce`, NOT BESIDE `initSentAt`'s
   * ONE-SHOT STAMP. The line above it is `if (marks.initSentAt === null)` —
   * deliberately once-per-launch. Folding the counter into that same guard is
   * the natural-looking edit and it produces a counter that is ALWAYS 1, i.e. a
   * metric that reports "every launch acked on the first post" — the exact
   * conclusion the field exists to test, delivered as a constant. This gate
   * pins the increment as its own unconditional statement.
   *
   * A source gate is the weaker instrument and is named as such: the
   * behavioural version can only live in the `component` project, which CI does
   * not run, so it would report safety from a tier nothing observes. Same trade
   * as the seed gate above.
   */
  function sendInitBody(src: string): string {
    const start = src.indexOf('const sendInitOnce = useCallback(');
    if (start === -1) return '';
    const end = src.indexOf('}, [send]);', start);
    if (end === -1) return '';
    return src.slice(start, end);
  }

  it('the extractor finds the sendInitOnce body and not the whole file', () => {
    // POSITIVE CONTROL for the extractor: without it, an `indexOf` that silently
    // missed would return '' and every assertion below would be red for a reason
    // unrelated to the host.
    const body = sendInitBody(fs.readFileSync(HOST, 'utf8'));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('BLOCK_INIT');
    // Bounded to the callback, not the file.
    expect(body).not.toContain('BLOCK_READY');
  });

  it('🔴 the host counts EVERY BLOCK_INIT post, unconditionally', () => {
    const body = sendInitBody(fs.readFileSync(HOST, 'utf8'));
    expect(body).toContain('marks.initPosts += 1');
    // 🔴 NOT folded into the one-shot `initSentAt` guard — that would pin the
    // count at 1 forever and make the metric answer its own question wrongly.
    expect(body).not.toMatch(/initSentAt === null\)[^\n]*initPosts/);
  });
});
