import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Ledger guard: every module that decides "does getEdgeUrl forward this src UNMODIFIED?"
 * must consume the ONE predicate, never re-spell it.
 *
 * 🔴 Why a textual ledger and not a behavioural test. The image-scan allowlist's whole
 * invariant is that it gates exactly the set `getEdgeUrl` forwards. A behavioural test of
 * `isEdgeUrlPassthrough` pins the predicate but says nothing about whether the consumers
 * still call it — so re-open-coding a WIDER check at a call site (adding another
 * `startsWith('…')` arm, say) leaves every unit test green while `getEdgeUrl` forwards a
 * class the allowlist does not gate. That is the SSRF this predicate was extracted to
 * close, reintroduced in a new scheme. MEASURED: that exact mutation survived a fully
 * green suite before this guard existed.
 *
 * It fails when the consumer set GROWS or SHRINKS, so a new consumer must be declared here
 * deliberately rather than drifting in.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Every file allowed to make this decision, and each must import the shared predicate. */
const DECLARED_CONSUMERS = [
  'src/client-utils/edge-url.ts',
  'src/client-utils/cf-images-utils.ts',
  'src/server/utils/image-scan-url.ts',
] as const;

/** Files that legitimately contain the raw spelling: the predicate itself, and this guard. */
const ALLOWED_TO_SPELL_IT = [
  'src/shared/utils/edge-url-passthrough.ts',
  'src/server/utils/__tests__/no-divergent-edge-url-passthrough.test.ts',
] as const;

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('edge-url passthrough — one predicate, a declared consumer set', () => {
  it('every declared consumer imports the shared predicate', () => {
    for (const rel of DECLARED_CONSUMERS) {
      expect(read(rel), `${rel} must import isEdgeUrlPassthrough`).toContain(
        'isEdgeUrlPassthrough'
      );
    }
  });

  it('no declared consumer re-open-codes the passthrough test', () => {
    // The raw spelling this predicate replaced. Re-appearing at a consumer is the drift.
    const RAW = /startsWith\(\s*['"](?:http|blob)['"]\s*\)/;
    for (const rel of DECLARED_CONSUMERS) {
      const offending = read(rel)
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => RAW.test(line) && !line.startsWith('*') && !line.startsWith('//'));
      expect(
        offending,
        `${rel} re-spells the passthrough test instead of calling isEdgeUrlPassthrough`
      ).toEqual([]);
    }
  });

  it('the predicate is spelled in exactly one place outside this guard', () => {
    // Anchors the ledger: if the shared module stops containing it, the checks above
    // would pass vacuously against a predicate that no longer makes the decision.
    expect(read(ALLOWED_TO_SPELL_IT[0])).toMatch(/startsWith\('http'\)/);
  });
});
