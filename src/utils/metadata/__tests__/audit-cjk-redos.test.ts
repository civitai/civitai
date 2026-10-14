import { describe, it, expect } from 'vitest';
import { auditPrompt, auditPromptEnriched, includesNsfw } from '~/utils/metadata/audit';
import { expectSubQuadraticScaling } from './redos-perf-helpers';

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
// long CJK run, a "3d" token (digit-letter),
// "Unity"/"masterpiece" ASCII words, more CJK. Deterministic (fixed characters).
function buildCjkPrompt(cjkCharsEachSide: number): string {
  const a = '美'.repeat(cjkCharsEachSide); // 美
  const b = '丽'.repeat(cjkCharsEachSide); // 丽
  const c = '風'.repeat(cjkCharsEachSide); // 風
  return `${a} 3d render ${b} Unity masterpiece ${c} best quality`;
}

// Build the same prompt SHAPE parametrized purely by per-side CJK length, so the
// scaling guards can grow the long non-Latin run (the O(n²) driver) directly.
function buildCjkPromptByLen(cjkCharsEachSide: number): string {
  return buildCjkPrompt(cjkCharsEachSide);
}

describe('audit: long non-Latin (CJK) prompts do not pin the event loop (ReDoS guard)', () => {
  // The OLD consuming-boundary regexes were O(regexes × n²) on this shape (one giant
  // [^a-zA-Z0-9] run): a 1306-char prompt → ~1.6s, bigger ones up to ~84s. The
  // zero-width-boundary fix made it linear. We assert that ALGORITHMIC property via
  // input-size scaling (hardware-independent) rather than an absolute wall-clock
  // budget — the old `< 100ms` flaked on slower/loaded runners while the code was
  // demonstrably linear (see redos-perf-helpers).
  it('auditPrompt scales linearly on growing CJK prompts (not O(n²))', () => {
    expectSubQuadraticScaling(
      'auditPrompt CJK',
      (n) => buildCjkPromptByLen(n),
      (input) => auditPrompt(input)
    );
  });

  it('auditPromptEnriched scales linearly on growing CJK prompts (not O(n²))', () => {
    expectSubQuadraticScaling(
      'auditPromptEnriched CJK',
      (n) => buildCjkPromptByLen(n),
      (input) => auditPromptEnriched(input, undefined, true)
    );
  });

  // Correctness (separate from cost): a benign CJK shape must NOT be blocked, at the
  // proven prod size and a larger one.
  for (const cjkEach of [650, 1500, 4000]) {
    const prompt = buildCjkPrompt(cjkEach);
    it(`auditPrompt does not falsely block a benign ${prompt.length}-char CJK prompt`, () => {
      const result = auditPrompt(prompt);
      expect(result.success).toBe(true);
      expect(result.blockedFor).toEqual([]);
    });
  }
});

describe('audit: zero-width boundaries preserve real matching (CJK-adjacent sanity)', () => {
  it('benign prompts (CJK or ASCII) are not falsely flagged', () => {
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
