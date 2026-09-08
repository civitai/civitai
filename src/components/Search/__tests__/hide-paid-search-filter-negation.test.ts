import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { HIDE_PAID_MODELS_FILTER } from '~/components/Search/paid-model-search-filter';
import { joinFilterClauses } from '~/components/Search/search-filters';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';

/**
 * These pin one decision, not the code around it: the "hide paid models" clause is a NEGATION and
 * must never become an equality on `false`.
 *
 * To whoever is about to simplify this to `hasActivePaidAccess = false` because it reads better —
 * that is the bug this ticket exists to prevent, and it fails silently rather than loudly. Only
 * GATED models carry `hasActivePaidAccess`; ~700K documents simply do not have the attribute, and
 * the card treats absent as false. In Meilisearch an equality matches only documents that HAVE the
 * attribute, while a negation also matches documents that lack it. So `= false` would hide almost
 * the entire index and "hide paid" would return nearly nothing.
 *
 * Measured on the live index against `cannotPromote`, which is sparse the same way:
 * `EXISTS` 1,853 · `= true` 1,115 · `NOT = true` >=100,000. That last number is the proof — if a
 * negation skipped absent documents it could not have exceeded 1,853 - 1,115 = 738.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const CALL_SITE = 'src/pages/search/models.tsx';

// This file states the forbidden spelling in order to forbid it, so it is the one exemption.
// Exactly one, asserted below: widening this list is the edit that must be visible in a diff.
const ALLOWLIST = [
  'src/components/Search/__tests__/hide-paid-search-filter-negation.test.ts',
] as const;

describe('hide-paid search filter', () => {
  it('is a negation, not an equality on false', () => {
    expect(HIDE_PAID_MODELS_FILTER).toMatch(/^NOT\s/);
    expect(HIDE_PAID_MODELS_FILTER).toContain('hasActivePaidAccess');
    expect(HIDE_PAID_MODELS_FILTER).not.toContain('false');
  });

  it('survives the parenthesising every clause gets before it reaches Meilisearch', () => {
    // joinFilterClauses wraps each clause in `(...)`. A clause that is only valid unwrapped would
    // fail as a 400 at runtime and never in a unit test that looked at the constant alone.
    expect(joinFilterClauses([HIDE_PAID_MODELS_FILTER])).toBe('(NOT hasActivePaidAccess = true)');
  });

  it('filters on an attribute the models index declares filterable', () => {
    // Without this the whole models search answers 400 invalid_search_filter the moment anyone
    // ticks the box — not just the paid filter, the entire result set.
    expect(filterableAttributesByIndex[MODELS_SEARCH_INDEX]).toContain('hasActivePaidAccess');
  });
});

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no equality-on-false spelling anywhere', () => {
  it('src/ never writes `hasActivePaidAccess = false`', () => {
    const offenders = walk(path.join(repoRoot, 'src'))
      .filter((file) => /hasActivePaidAccess\s*=\s*false/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWLIST.includes(file as (typeof ALLOWLIST)[number]));

    expect(ALLOWLIST).toHaveLength(1);

    expect(
      offenders,
      'Use a NOT clause. An equality does not match documents that lack the attribute.'
    ).toEqual([]);
  });

  it('the call site uses the shared constant rather than an inline string', () => {
    // The constant carries the reasoning. Inlining the string is how the reasoning gets lost and
    // the next edit reaches for `= false`.
    const source = readFileSync(path.join(repoRoot, CALL_SITE), 'utf8');

    expect(source).toContain('HIDE_PAID_MODELS_FILTER');
    expect(source).not.toContain("'NOT hasActivePaidAccess");
  });
});
