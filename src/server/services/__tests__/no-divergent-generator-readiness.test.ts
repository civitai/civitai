import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generatorReadiness, isGeneratorReady } from '~/shared/generation/generator-readiness';

/**
 * Four surfaces ask "can this generate now?" and the column answers it wrongly for an
 * `ExternalGeneration` version — see `generator-readiness.ts`. This pins the single derivation.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const HELPER = 'src/shared/generation/generator-readiness.ts';

/** Where the column may still be read raw: the helper, and the rows that write or sync it. */
const ALLOWLIST = [
  HELPER,
  // Write or report the column itself — the raw fact, before the rule.
  'src/server/jobs/sync-generator-loaded-resources.ts',
  'src/pages/api/webhooks/resource-availability.ts',
  'src/pages/api/testing/generator-loaded.ts',
  'src/pages/api/testing/orchestrator-loaded.ts',
  // Field declarations and raw projections, not readings.
  'src/server/redis/resource-data.redis.ts',
  // An inline Prisma select, same as the selector modules below it — declaring the field so
  // `coveredByForUser` can read it, not deciding anything with it.
  'src/server/controllers/model-version.controller.ts',
  'src/server/selectors/model.selector.ts',
  'src/server/selectors/modelVersion.selector.ts',
  'src/server/search-index/filterable-attributes.ts',
  // Both index writers, which compose the field through the helper — pinned by the last test.
  'src/server/search-index/models.search-index.ts',
  'src/pages/api/mod/search/models-update.ts',
  // Restates the rule in SQL, where the helper cannot be called — pinned by 'the SQL restatement
  // keeps both halves of the readiness rule' below.
  'src/server/services/generation/coverage-source.ts',
  // These read the INDEXED field, which already carries readiness.
  'src/shared/generation/coverage-fields.ts',
  'src/server/services/resource-select.service.ts',
  'src/components/ImageGeneration/GenerationForm/resource-select.types.ts',
  'src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard.tsx',
] as const;

/** A comment naming the column is not a reading of it — the flag's own docs mention it. */
function stripComments(text: string) {
  const block = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const line = new RegExp('//[^\\n]*', 'g');
  return text.replace(block, '').replace(line, '');
}

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
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

describe('generator readiness is derived in one place', () => {
  it('an external version is ready, whatever the column says', () => {
    expect(generatorReadiness({ generatorLoaded: false, usageControl: 'ExternalGeneration' })).toBe(
      'external'
    );
    expect(isGeneratorReady({ generatorLoaded: false, usageControl: 'ExternalGeneration' })).toBe(
      true
    );
  });

  it('a resident version is loaded and a cold one is cold', () => {
    expect(generatorReadiness({ generatorLoaded: true, usageControl: 'Download' })).toBe('loaded');
    expect(generatorReadiness({ generatorLoaded: false, usageControl: 'Download' })).toBe('cold');
    expect(generatorReadiness({})).toBe('cold');
  });

  it('the three states stay distinct — collapsing external into loaded loses the label', () => {
    const states = new Set(
      [
        { generatorLoaded: true },
        { generatorLoaded: false },
        { usageControl: 'ExternalGeneration' },
      ].map(generatorReadiness)
    );
    expect(states.size).toBe(3);
  });

  it('nothing else decides readiness from the column alone', () => {
    const offenders = sourceFiles
      .filter((f) => !ALLOWLIST.includes(f.rel as (typeof ALLOWLIST)[number]))
      .filter((f) => /\bgeneratorLoaded\b/.test(stripComments(f.text)))
      .map((f) => f.rel);

    expect(
      offenders,
      `These read \`generatorLoaded\` without generatorReadiness/isGeneratorReady. The column is ` +
        `false forever for an ExternalGeneration version, so reading it alone tells an API model's ` +
        `user to wait for a download that will never happen.`
    ).toEqual([]);
  });

  /**
   * `coveredForUserSql` is the one place the readiness rule is restated in SQL, because a predicate
   * sent to Postgres cannot call `generatorReadiness`. Dropping the `ExternalGeneration` half is
   * the exact divergence this guard exists for, and it would be invisible: the column really is
   * false for those versions, so the SQL would simply gate every API checkpoint.
   */
  it('the SQL restatement keeps both halves of the readiness rule', () => {
    const text =
      sourceFiles.find((f) => f.rel === 'src/server/services/generation/coverage-source.ts')
        ?.text ?? '';
    expect(text, 'coverage-source.ts must still build the SQL predicate').toMatch(
      /export function coveredForUserSql/
    );
    expect(text, 'the SQL must accept a resident version').toMatch(/"generatorLoaded"/);
    expect(text, 'the SQL must also accept an ExternalGeneration version').toMatch(
      /ExternalGeneration/
    );
  });

  it('the allowlisted index writers compose the field through the helper', () => {
    for (const rel of [
      'src/server/search-index/models.search-index.ts',
      'src/pages/api/mod/search/models-update.ts',
    ]) {
      const text = sourceFiles.find((f) => f.rel === rel)?.text ?? '';
      expect(text, `${rel} must write the indexed field through isGeneratorReady`).toMatch(
        /generatorLoaded:\s*isGeneratorReady\(/
      );
    }
  });
});
