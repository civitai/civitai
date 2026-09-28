import { execFileSync } from 'child_process';
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
 * 🔴 WHAT THIS DOES AND DOES NOT CATCH — stated because an overclaiming guard is worse than
 * no guard: it stops the next person looking.
 *
 * CATCHES: a declared consumer re-spelling the predicate as the literal
 * `startsWith('http'|'blob')`, and an UNDECLARED file in `src/` doing the same. Both were
 * measured against a planted mutation, in both directions.
 *
 * DOES NOT CATCH: a semantically-equivalent respelling — a backtick literal, a regex,
 * `indexOf(...) === 0`, `slice(0,4)`, or deleting the call outright. All of those were
 * measured to survive this guard. It is textual, so only the one spelling is fenced.
 *
 * Why that is ACCEPTABLE rather than a hole to widen: the allowlist no longer DEPENDS on this
 * parity for its security property. `isAllowedImageScanUrl` judges shape independently —
 * `SCHEME_PREFIX` plus the leading-`//` test on the relative branch, and `parsed.protocol` on
 * the passthrough branch — so a `getEdgeUrl` widened to forward some new scheme cannot admit
 * it. Gross divergence is caught behaviourally (forcing the predicate to a constant reddens
 * 7 and 3 of the allowlist's rows respectively). This guard's remaining job is the cheap,
 * high-frequency case: someone copy-pasting the old one-liner back in. It is not, and should
 * not be read as, a proof that only one implementation of the boundary exists.
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

/**
 * The file's lines with comment lines dropped. Crude on purpose — it only has to stop a
 * docblock DISCUSSING the predicate from being scored as an implementation of it, which the
 * modules in this arc do at length. A guard that false-positives on its own explanation is a
 * guard someone deletes.
 */
const codeLines = (body: string) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');

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

  it('the shared predicate still contains the boundary test it owns', () => {
    // Anchors the ledger: if the shared module stops containing it, the checks above would
    // pass vacuously against a predicate that no longer makes the decision. Named for what it
    // asserts — it does NOT count occurrences repo-wide, which an earlier title implied.
    expect(read(ALLOWED_TO_SPELL_IT[0])).toMatch(/startsWith\('http'\)/);
    // And this guard is the only other file allowed to carry the literal.
    expect(ALLOWED_TO_SPELL_IT[1]).toContain('no-divergent-edge-url-passthrough');
  });

  /**
   * 🔴 The GROWTH half. Iterating `DECLARED_CONSUMERS` alone can only catch a declared file
   * re-spelling the predicate — a NEW file open-coding it is invisible, so without this the
   * guard's own description ("fails when the set grows or shrinks") would claim coverage the
   * body does not provide. This scans the corpus instead of trusting the list.
   *
   * Scoped to `src/`: the three `apps/` spokes carry their own ported copies and cannot
   * import from `src/shared/**` at all, so they are a separate, known problem rather than
   * something this guard can police. Naming that here keeps it a recorded exclusion instead
   * of a silent blind spot.
   */
  it('no UNDECLARED file in src/ open-codes the two-arm passthrough test', () => {
    // `git grep -I` over the tracked corpus: not the shell `grep` wrapper, which is
    // gitignore-aware and would quietly skip files, and not a recursive walk into
    // node_modules.
    // 🔴 `--untracked` is load-bearing: plain `git grep` searches only TRACKED files, so a
    // brand-new consumer would be invisible until it was staged — and the mutation proving
    // this test works would pass. (`-I` skips binaries; `--untracked` still honours
    // .gitignore, so node_modules is not walked.)
    const out = execFileSync(
      'git',
      [
        'grep',
        '-I',
        '--untracked',
        '-l',
        '-E',
        'startsWith\\([\'"](http|blob)[\'"]\\)',
        '--',
        'src/',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const hits = out.split('\n').filter(Boolean);
    const allowed = new Set<string>([...DECLARED_CONSUMERS, ...ALLOWED_TO_SPELL_IT]);
    // Only files carrying BOTH arms in CODE decide the passthrough question. Comments are
    // stripped first — otherwise a file merely *discussing* the predicate (this module's own
    // docblocks do) is flagged, and a guard with false positives gets deleted.
    const twoArm = hits.filter((rel) => {
      const code = codeLines(read(rel));
      return /startsWith\(['"]http['"]\)/.test(code) && /startsWith\(['"]blob['"]\)/.test(code);
    });
    expect(twoArm.filter((rel) => !allowed.has(rel))).toEqual([]);
  });
});
