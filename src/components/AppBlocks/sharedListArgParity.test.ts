import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from './stripSourceComments';

/**
 * App Blocks host PARITY guard: the two bridge hosts must pass the SAME argument
 * keys to `trpc.apps.shared.list`.
 *
 * WHY THIS EXISTS — a measured gap, not a hypothetical. Round 1 of `/audit-pr` on
 * civitai#5361 deleted BOTH `mine` lines from `IframeHost.tsx` and ran everything
 * that could plausibly see it: `hostHandlerParity` + `blockStorageCacheParity`
 * (170 passed) and the two host browser suites (46 passed). **216 green with the
 * forwarding gone.** Nothing in the repo asserts IframeHost's `apps.shared.list`
 * argument object — `hostHandlerParity` only greps that `onMessage('SHARED_LIST'`
 * is REGISTERED, `blockStorageCacheParity` only counts read sites carrying
 * `BLOCK_STORAGE_READ_OPTS`, and there is no `IframeHostSharedStorage` browser
 * suite at all. PageBlockHost has behavioural coverage; IframeHost had none.
 *
 * The failure that buys: a refactor drops an argument from ONE host, every gate
 * stays green, and a model-slot block silently serves a different result set from
 * the same block rendered on a page. `mine` makes that concrete — the whole board
 * instead of the viewer's own rows — but the guard is deliberately about the KEY
 * SET rather than about `mine`, so it covers the next argument too.
 *
 * 🔴 It is STRUCTURAL and asserts a RELATIONSHIP, not a list. It does not pin
 * WHICH keys are passed — adding one to both hosts needs no edit here, which is
 * the point: a guard that enumerates today's keys has to be updated in lockstep
 * and gets updated wrong. It fails only when the two hosts DISAGREE, in either
 * direction (a key added to one, or removed from one).
 */

const HOST_DIR = join(__dirname);
const HOSTS = ['IframeHost.tsx', 'PageBlockHost.tsx'] as const;

/**
 * Pull the top-level keys of the object literal passed as the first argument of
 * `trpc*.apps.shared.list.fetch(`. Brace-balanced rather than regex-matched, so a
 * nested object or a trailing options argument cannot truncate it.
 */
function sharedListArgKeys(src: string): string[] {
  const marker = 'apps.shared.list.fetch(';
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('no apps.shared.list.fetch( call site found');
  // 🔴 A SECOND CALL SITE MAKES THIS GUARD BLIND, so refuse rather than read the
  // first. Measured: with an earlier `fetch(` carrying the full key set, dropping
  // `mine` from the REAL serving call left this test green with a live fork in
  // the file — `indexOf` had already stopped looking. Throwing converts the
  // silent pass into a loud failure that says what to do (teach the parser which
  // site is the serving one).
  if (src.indexOf(marker) !== src.lastIndexOf(marker)) {
    throw new Error(
      'more than one apps.shared.list.fetch( call site — this parser reads only the first, so it can no longer see a divergence; teach it which site serves SHARED_LIST'
    );
  }
  const open = src.indexOf('{', at + marker.length);
  if (open === -1) throw new Error('no object literal after apps.shared.list.fetch(');

  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('unbalanced object literal at the call site');

  const body = src.slice(open + 1, end);
  // Top-level keys only: skip anything nested inside a deeper brace/bracket/paren.
  const keys: string[] = [];
  let d = 0;
  for (const segment of body.split(',')) {
    const before = d;
    for (const ch of segment) {
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
    }
    if (before !== 0) continue;
    // 🔴 A SPREAD DEFEATS KEY COMPARISON, so refuse rather than drop it. Measured:
    // adding `...extraArgs` to ONE host's literal left this test green — the key
    // regex below requires an identifier at segment start, so `...x` matched
    // nothing and vanished. A spread in one host and not the other is precisely
    // the divergence this file exists to catch, and it was the invisible case.
    if (/^\s*\.\.\./.test(segment)) {
      throw new Error(
        'a spread in the apps.shared.list.fetch( argument — key comparison cannot see through it; inline the keys or teach this parser to resolve the spread'
      );
    }
    const m = segment.match(/^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/);
    if (m) keys.push(m[1]);
  }
  return keys.sort();
}

/**
 * 🔴 PARSED INSIDE THE TESTS, NOT AT MODULE SCOPE, AND THAT IS NOT A STYLE CHOICE.
 * `sharedListArgKeys` THROWS on the two shapes it cannot see through (a spread, a
 * second call site). Computed in the `describe` body, those throws are a
 * COLLECTION error: vitest reports `Tests  no tests` — a reassuring zero that a
 * report-only lane renders as "nothing to see" rather than as a failure. Measured
 * that exact output before moving it. Inside an `it`, the same throw is a failed
 * test with the message attached.
 */
function keysFor(host: (typeof HOSTS)[number]): string[] {
  return sharedListArgKeys(stripSourceComments(readFileSync(join(HOST_DIR, host), 'utf8')));
}

describe('host parity: trpc.apps.shared.list argument keys', () => {
  it('parses a non-trivial key set out of BOTH hosts (positive control)', () => {
    const keys = Object.fromEntries(HOSTS.map((h) => [h, keysFor(h)])) as Record<
      (typeof HOSTS)[number],
      string[]
    >;
    // Without this, a parser that silently returned [] for both would make the
    // parity assertion below pass vacuously — the reassuring-zero failure mode.
    // `blockToken` must be there: it is the one key neither host can omit.
    for (const h of HOSTS) {
      expect(keys[h].length, `${h} parsed key count`).toBeGreaterThan(3);
      expect(keys[h], `${h} must pass blockToken`).toContain('blockToken');
    }
  });

  it('🔴 both hosts pass the SAME key set — a key added to or dropped from one is a silent behaviour fork', () => {
    expect(keysFor('IframeHost.tsx')).toEqual(keysFor('PageBlockHost.tsx'));
  });
});
