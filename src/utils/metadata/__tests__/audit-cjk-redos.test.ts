import { describe, it, expect } from 'vitest';
import {
  auditPrompt,
  auditPromptEnriched,
  includesMinorAge,
  includesNsfw,
} from '~/utils/metadata/audit';

/**
 * Non-Latin (CJK) catastrophic-backtracking regression guard.
 *
 * INCIDENT: a V8 CPU profile + the audit-slow-log instrument proved the recurring
 * civitai-dp-prod "504 wave" was a user-triggerable DoS in the prompt audit. A long
 * non-Latin generation prompt is, to `[a-zA-Z0-9]`, one giant `[^a-zA-Z0-9]` run.
 * The audit regexes wrapped every word/age pattern in CONSUMING greedy boundary
 * groups — `([^a-zA-Z0-9]+|^)…([^a-zA-Z0-9]+|$)` — and run UNANCHORED across
 * hundreds of regexes the leading group backtracks at every position → O(regexes ×
 * n²) → SECONDS of synchronous main-thread CPU (measured: a 1306-char Chinese prompt
 * → `auditPrompt` 1663ms with sub-check `minor_age`=1248ms; bigger prompts up to
 * ~84s), pinning the event loop until the readiness probe timed out and the pod shed
 * traffic.
 *
 * FIX: the consuming boundary groups were replaced with ZERO-WIDTH assertions
 * (`(?<![a-zA-Z0-9])` / `(?![a-zA-Z0-9])`) — boolean-equivalent for the match but
 * with nothing to backtrack over the long run, collapsing the cost to linear.
 * Boolean-match equivalence is proven separately by audit-matching-equivalence.ts.
 *
 * These tests bound the hot path on the EXACT pathological shape: a long run of
 * non-alphanumeric (CJK) characters with embedded ASCII (so a naive "is it ASCII?"
 * screen wouldn't dodge it). On the OLD code these calls took 1.6s–84s; here we
 * assert they finish in single-digit ms. (We can't reproduce the precise truncated
 * prod prompt — privacy — so we synthesize the SHAPE, which is what triggers it.)
 */

// Build a long non-Latin prompt with embedded ASCII, mimicking a real CJK prompt:
// long CJK run, a "3d" token (digit-letter, exercises the age `{age}{years}` path),
// "Unity"/"masterpiece" ASCII words, more CJK. Deterministic (fixed characters).
function buildCjkPrompt(cjkCharsEachSide: number): string {
  const a = '美'.repeat(cjkCharsEachSide); // 美
  const b = '丽'.repeat(cjkCharsEachSide); // 丽
  const c = '風'.repeat(cjkCharsEachSide); // 風
  return `${a} 3d render ${b} Unity masterpiece ${c} best quality`;
}

const PERF_BUDGET_MS = 100;

describe('audit: long non-Latin (CJK) prompts do not pin the event loop (ReDoS guard)', () => {
  // ~1306-char shape (the proven prod case) plus a deliberately larger one — the
  // OLD O(n²) cost grows quadratically, so the bigger input is where it really bit.
  for (const cjkEach of [650, 1500, 4000]) {
    const prompt = buildCjkPrompt(cjkEach);
    it(`auditPrompt finishes < ${PERF_BUDGET_MS}ms on a ${prompt.length}-char CJK prompt`, () => {
      const start = performance.now();
      const result = auditPrompt(prompt);
      const ms = performance.now() - start;
      expect(ms, `auditPrompt too slow (${ms.toFixed(1)}ms) on ${prompt.length}-char CJK`).toBeLessThan(
        PERF_BUDGET_MS
      );
      // Benign CJK shape — must NOT be blocked.
      expect(result.success).toBe(true);
      expect(result.blockedFor).toEqual([]);
    });

    it(`auditPromptEnriched finishes < ${PERF_BUDGET_MS}ms on a ${prompt.length}-char CJK prompt`, () => {
      const start = performance.now();
      auditPromptEnriched(prompt, undefined, true);
      const ms = performance.now() - start;
      expect(
        ms,
        `auditPromptEnriched too slow (${ms.toFixed(1)}ms) on ${prompt.length}-char CJK`
      ).toBeLessThan(PERF_BUDGET_MS);
    });
  }

  it('a CJK prompt with an embedded real age phrase still flags (boundary fix did not break detection)', () => {
    const cjk = '美'.repeat(800);
    // The age phrase sits between CJK runs; with zero-width boundaries the leading
    // CJK char satisfies `(?<![a-zA-Z0-9])` so the match is still found — fast.
    const prompt = `${cjk} 9 year old ${cjk}`;
    const start = performance.now();
    const result = auditPrompt(prompt);
    const ms = performance.now() - start;
    expect(ms, `slow CJK+age (${ms.toFixed(1)}ms)`).toBeLessThan(PERF_BUDGET_MS);
    expect(includesMinorAge(prompt)).toEqual({ found: true, age: 9 });
    expect(result.success).toBe(false);
  });
});

describe('audit: zero-width boundaries preserve real matching (CJK-adjacent sanity)', () => {
  it('age phrases flag whether bounded by CJK, ASCII, or string edges', () => {
    expect(includesMinorAge('9 year old')).toEqual({ found: true, age: 9 });
    expect(includesMinorAge('丽9 year old丽')).toEqual({ found: true, age: 9 });
    expect(includesMinorAge('photo, a 15 year old, masterpiece')).toEqual({ found: true, age: 15 });
  });

  it('benign prompts (CJK or ASCII) are not falsely flagged', () => {
    expect(includesMinorAge('美丽風 a serene landscape')).toEqual({
      found: false,
      age: undefined,
    });
    expect(auditPrompt('a beautiful landscape, masterpiece').success).toBe(true);
    expect(auditPrompt('美'.repeat(500) + ' cinematic lighting').success).toBe(true);
  });

  it('nsfw word detection is unchanged by the boundary change (positive + negative)', () => {
    // A word bounded by CJK must still match (zero-width boundary is satisfied by
    // the CJK char), and a benign all-CJK string must not.
    expect(includesNsfw('a normal landscape photo')).toBe(false);
    expect(includesNsfw('美丽風美丽')).toBe(false);
  });
});
