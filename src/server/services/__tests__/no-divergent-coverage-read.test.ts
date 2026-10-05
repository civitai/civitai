import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `GenerationCoverage` carries both rules as columns — `covered` (the weekly auction's list) and
 * `coveredNext` (community checkpoints, downloaded on demand) — and a Flipt flag decides which one
 * answers. A flag is only a kill switch if every surface flips together: one copy of
 * `next ? coveredNext : covered` left behind is a Create button the submit refuses, or a model the
 * picker hides while generation would have taken it.
 *
 * So the choice is made in two places and this pins that: `pickCovered`/`coveredBy` for the database
 * columns, `versionCanGenerate` for the indexed pair the client sees. The ternary itself is the
 * textual property, which is the one kind a text guard checks well.
 *
 * The positive controls below are load-bearing: without them, deleting the helpers or renaming the
 * columns makes every prohibition vacuously green.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const COLUMN_HELPER = 'src/server/services/generation/coverage-source.ts';
const INDEX_HELPER = 'src/shared/generation/coverage-fields.ts';
const FLAG_DECL = 'src/server/flipt/client.ts';

/** `next ? a.coveredNext : a.covered`, either way round. */
const COLUMN_TERNARY = [
  /\?[^:\n]*\bcoveredNext\b[^:\n]*:[^;\n]*\bcovered\b/,
  /\?[^:\n]*\bcovered\b[^:\n]*:[^;\n]*\bcoveredNext\b/,
];
const INDEX_TERNARY = [
  /\?[^:\n]*\bcanGenerateNext\b[^:\n]*:[^;\n]*\bcanGenerate\b/,
  /\?[^:\n]*\bcanGenerate\b[^:\n]*:[^;\n]*\bcanGenerateNext\b/,
];

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(path.join(repoRoot, 'src'))
  .map((full) => ({
    rel: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
  // Tests quote the expressions they pin, including this file.
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

const fileText = (rel: string) => sourceFiles.find((f) => f.rel === rel)?.text;
const matching = (patterns: RegExp[], allowed: string) =>
  sourceFiles
    .filter((f) => f.rel !== allowed && patterns.some((p) => p.test(f.text)))
    .map((f) => f.rel);

describe('which coverage rule answers is decided in one place', () => {
  it('the column helper exists and makes the choice', () => {
    const text = fileText(COLUMN_HELPER);
    expect(text, `${COLUMN_HELPER} is where the choice lives`).toBeDefined();
    expect(text).toMatch(/export function pickCovered/);
    expect(
      COLUMN_TERNARY.some((p) => p.test(text!)),
      `${COLUMN_HELPER} no longer chooses between the two columns — if the columns were renamed, ` +
        `this guard is now checking nothing`
    ).toBe(true);
  });

  it('the indexed pair is chosen between in one place too', () => {
    const text = fileText(INDEX_HELPER);
    expect(text, `${INDEX_HELPER} is where the indexed choice lives`).toBeDefined();
    expect(text).toMatch(/export function versionCanGenerate/);
    expect(
      INDEX_TERNARY.some((p) => p.test(text!)),
      `${INDEX_HELPER} no longer chooses between canGenerate and canGenerateNext`
    ).toBe(true);
  });

  it('no other module picks between the two coverage columns', () => {
    expect(
      matching(COLUMN_TERNARY, COLUMN_HELPER),
      `These read the coverage columns directly instead of pickCovered/coveredBy. A copy left ` +
        `behind keeps answering under the old rule after the flag flips.`
    ).toEqual([]);
  });

  it('no other module picks between the two indexed gates', () => {
    expect(
      matching(INDEX_TERNARY, INDEX_HELPER),
      `These read the indexed gates directly instead of versionCanGenerate — the picker would then ` +
        `offer what the server filtered out, or hide what it kept.`
    ).toEqual([]);
  });

  /**
   * Who gets the `coveredNext` expansion is a second decision on top of which rule answers, and it
   * has the same failure: one surface deciding it differently is a Create button the submit
   * refuses. Both halves derive it in one place, and the audience itself is resolved in one place.
   */
  it('who gets the expansion is derived in one place per side', () => {
    expect(fileText(COLUMN_HELPER)).toMatch(/export function coveredForUser/);
    expect(fileText(INDEX_HELPER)).toMatch(/export function versionGeneratableFor/);
  });

  /**
   * The tell is an expansion column weighed against residency. Either order, across newlines, and
   * residency in any of its spellings — the helper form is what the readiness guard pushes you
   * toward, so a restatement written that way would otherwise slip both guards at once.
   */
  const READY = 'generatorLoaded|isGeneratorReady|generatorReadiness';
  const NEXT = 'coveredNext|canGenerateNext';
  // One statement, with a boolean operator between them: that is a DECISION. A Prisma select or a
  // field list names the same identifiers across separate lines and must not trip this.
  const RESTATED = [
    new RegExp(`(${NEXT})[^;\n]*(&&|\\|\\|)[^;\n]*(${READY})`),
    new RegExp(`(${READY})[^;\n]*(&&|\\|\\|)[^;\n]*(${NEXT})`),
  ];

  /**
   * The control. Without it a rename of either column makes the prohibition below vacuously green
   * — it would report "nobody restates the rule" because the pattern no longer matches anything.
   */
  it('the two helpers themselves match the restatement pattern', () => {
    for (const rel of [COLUMN_HELPER, INDEX_HELPER]) {
      expect(
        RESTATED.some((r) => r.test(fileText(rel) ?? '')),
        `${rel} no longer pairs an expansion column with residency — if either was renamed, the ` +
          `prohibition below is now checking nothing`
      ).toBe(true);
    }
  });

  it('no other module restates the members rule', () => {
    const offenders = sourceFiles
      .filter((f) => f.rel !== COLUMN_HELPER && f.rel !== INDEX_HELPER)
      .filter((f) => RESTATED.some((r) => r.test(f.text)))
      .map((f) => f.rel);
    expect(
      offenders,
      `These pair the expansion column with residency themselves instead of calling ` +
        `coveredForUser / versionGeneratableFor. A second copy is a surface that keeps gating ` +
        `after the rollout opens, or stops gating before it does.`
    ).toEqual([]);
  });

  it('the rollout flag is read only where the audience is resolved', () => {
    const readers = sourceFiles
      .filter((f) => f.text.includes('GENERATION_LOADING_OPEN_TO_ALL'))
      .map((f) => f.rel)
      .sort();
    expect(
      readers,
      `only ${FLAG_DECL} (declaration) and ${COLUMN_HELPER} (coverageAudience) may name it`
    ).toEqual([COLUMN_HELPER, FLAG_DECL].sort());
  });

  it('the flag is read only where the per-request answer is resolved', () => {
    // Resolved once per request and passed down: a second reader could evaluate differently
    // mid-request and have one surface covering a version another refuses.
    const readers = sourceFiles
      .filter((f) => f.text.includes('GENERATION_COVERAGE_NEXT'))
      .map((f) => f.rel)
      .sort();
    expect(
      readers,
      `only ${FLAG_DECL} (declaration) and ${COLUMN_HELPER} may name the flag`
    ).toEqual([COLUMN_HELPER, FLAG_DECL].sort());
  });
});
