import { describe, it, expect } from 'vitest';
import {
  auditPrompt,
  includesNsfw,
  includesPoi,
  includesMinor,
  getTagsFromPrompt,
} from '~/utils/metadata/audit';

/**
 * ReDoS (catastrophic regex backtracking) regression guard.
 *
 * PR #2452 added a combined-regex "gate" pre-filter to `checkable().inPrompt`:
 *
 *   new RegExp(`([^a-zA-Z0-9]+|^)(?:${chunk})([^a-zA-Z0-9]+|$)`, 'i')
 *
 * where `chunk` joined up to 200 per-word bodies with `|`. The greedy
 * `[^a-zA-Z0-9]+` boundary groups on BOTH sides of a 200-way alternation —
 * several of whose bodies themselves contain unbounded quantifiers like
 * `[\s|\w]*` (e.g. `without [\s|\w]* clothes`) — backtrack pathologically on
 * certain user prompts. A V8 CPU profile of a prod civitai-dp-prod api pod
 * caught single `inPrompt()` calls burning 11s / 25s / 47s of SYNCHRONOUS
 * main-thread CPU on user generation prompts, pegging the event loop until the
 * readiness probe timed out and the pod shed traffic (a user-triggerable DoS →
 * the recurring "504 wave"). The gate has been removed; `inPrompt`/`highlight`
 * now go straight to the per-word loop (the pre-#2452 behavior that ran fine
 * for years).
 *
 * These tests are a HOT-PATH LATENCY guard for the public audit API. They feed
 * the adversarial input shapes that stress the removed gate — long runs of
 * non-alphanumeric separators, whitespace ambiguously partitioned across
 * multiple greedy quantifiers, leet-class soup, and near-miss blocklist
 * fragments — through `auditPrompt`/`includesNsfw`/`includesPoi`/etc. and assert
 * each call completes well within a per-call wall-clock bound, plus an aggregate
 * bound over the whole battery.
 *
 * HONESTY NOTE: the exact prod input that backtracked for 11-47s was a specific
 * user prompt not captured in the profile, and modern V8's irregexp defuses most
 * synthetic catastrophic-backtracking constructions — so these inputs do NOT
 * reproduce a multi-second hang on a current Node runtime. What they DO is bound
 * the audit hot path: if a quadratic/exponential pre-filter (the #2452 gate, or
 * any successor) is reintroduced and an input pushes it into seconds, the bound
 * (and/or vitest's default timeout) trips. Matching CORRECTNESS after removing
 * the gate is covered separately by audit-matching-equivalence.test.ts, which
 * reconstructs the brute-force per-word oracle and asserts the public API agrees.
 */

// Per-call upper bound. The gateless per-word loop over the full blocklist is
// linear-to-mildly-polynomial in input length and finishes in a few ms to low
// tens of ms on realistic-sized prompts; the removed exponential gate took 11-47
// SECONDS on a single call in prod. 500ms gives generous headroom for a loaded
// CI runner over linear work while still tripping orders of magnitude before a
// true ReDoS hang.
const MAX_MS = 500;

// Inputs are kept to realistic generation-prompt sizes (<= ~300 chars). A ReDoS
// blows up on input STRUCTURE, not raw length, so a normal-length prompt is
// enough to expose catastrophic backtracking — and keeping the battery small
// keeps the legitimate linear scan fast so the bound stays meaningful.
function timeCall(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// Adversarial inputs crafted to maximize backtracking against the removed gate:
// a near-miss blocklist token prefix, then an ambiguous run that the leading
// boundary group, any interior `[^a-zA-Z0-9]+`/`[\s|\w]*`, and the trailing
// boundary group all compete to consume.
function buildPathologicalInputs(): { label: string; input: string }[] {
  const inputs: { label: string; input: string }[] = [];

  // Multi-word blocklist bodies with an interior unbounded quantifier
  // (`without [\s|\w]* clothes`, `jerks? [\s|\w]* off`, `spreads? [her|his|its]*
  // legs?`), fed a token prefix + ambiguous separator run that never completes
  // the trailing token — the multi-quantifier partition explosion the gate
  // amplified across a 200-way alternation.
  for (const n of [40, 120]) {
    inputs.push({ label: `without+ws(${n})`, input: 'without' + ' '.repeat(n) + 'x' });
    inputs.push({ label: `jerks+ws(${n})`, input: 'jerks' + ' '.repeat(n) + 'x' });
  }
  inputs.push({ label: 'spreads+mix', input: 'spreads' + ' -_.'.repeat(50) + 'x' });

  // Pure non-alphanumeric separator runs (the boundary groups' worst case).
  for (const sep of ['!', '-', '_', '.', '*']) {
    inputs.push({ label: `sep '${sep}' x200`, input: 'a' + sep.repeat(200) + 'b' });
  }

  // Alternating separator/letter — forces the boundary groups to re-anchor
  // repeatedly across the string.
  inputs.push({ label: 'alt sep x100', input: '! '.repeat(100) + 'z' });
  inputs.push({ label: 'dash-letter x100', input: 'a-'.repeat(100) + 'z' });

  // Leet-class soup: chars drawn from the leet substitution classes
  // ([i|l|1], [o|0], [s|z], [e|3]) against the many overlapping leet bodies.
  inputs.push({ label: 'leet soup', input: 'e3o0s zil1'.repeat(25) });

  // Repeated near-miss of a real blocklist word with separators between repeats.
  inputs.push({ label: 'near-miss repeat', input: 'explici '.repeat(30) + '!!!!!!!!' });

  // A long-ish benign prompt (the common case the gate was meant to speed up) —
  // must also stay fast through the per-word loop.
  inputs.push({
    label: 'benign',
    input: 'a beautiful landscape, masterpiece, best quality, ' + 'detailed '.repeat(15),
  });

  return inputs;
}

const pathological = buildPathologicalInputs();

describe('audit ReDoS regression (no catastrophic backtracking)', () => {
  it('auditPrompt completes fast on every adversarial input', () => {
    for (const { label, input } of pathological) {
      const ms = timeCall(() => auditPrompt(input));
      expect(ms, `auditPrompt too slow on ${label} (${ms.toFixed(1)}ms)`).toBeLessThan(MAX_MS);
    }
  });

  it('includesNsfw completes fast on every adversarial input', () => {
    for (const { label, input } of pathological) {
      const ms = timeCall(() => includesNsfw(input));
      expect(ms, `includesNsfw too slow on ${label} (${ms.toFixed(1)}ms)`).toBeLessThan(MAX_MS);
    }
  });

  it('includesPoi / includesMinor / getTagsFromPrompt complete fast on every adversarial input', () => {
    for (const { label, input } of pathological) {
      const poiMs = timeCall(() => includesPoi(input));
      expect(poiMs, `includesPoi too slow on ${label} (${poiMs.toFixed(1)}ms)`).toBeLessThan(MAX_MS);
      const minorMs = timeCall(() => includesMinor(input));
      expect(minorMs, `includesMinor too slow on ${label} (${minorMs.toFixed(1)}ms)`).toBeLessThan(
        MAX_MS
      );
      const tagMs = timeCall(() => getTagsFromPrompt(input));
      expect(tagMs, `getTagsFromPrompt too slow on ${label} (${tagMs.toFixed(1)}ms)`).toBeLessThan(
        MAX_MS
      );
    }
  });

  it('the whole adversarial battery audits in well under a true-hang timeout', () => {
    // Belt-and-suspenders: a single exponential call took 11-47s in prod; the
    // entire battery here must finish in a fraction of a second. If a quadratic/
    // exponential pre-filter is reintroduced this aggregate bound trips long
    // before any individual 250ms check could mask it.
    const ms = timeCall(() => {
      for (const { input } of pathological) {
        auditPrompt(input);
        includesNsfw(input);
      }
    });
    expect(ms, `full adversarial battery too slow (${ms.toFixed(1)}ms)`).toBeLessThan(3000);
  });
});
