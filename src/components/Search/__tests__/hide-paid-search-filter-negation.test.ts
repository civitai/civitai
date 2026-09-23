import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  HIDE_PAID_MODELS_FILTER,
  paidModelsSearchFilterClause,
} from '~/components/Search/paid-model-search-filter';
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

// This file states the forbidden spellings in order to forbid them, so it is the one exemption.
// Exactly one, asserted below: widening this list is the edit that must be visible in a diff.
const ALLOWLIST = [
  'src/components/Search/__tests__/hide-paid-search-filter-negation.test.ts',
] as const;

describe('hide-paid search filter', () => {
  it('is a negation, not an equality on false', () => {
    // The exact string is the load-bearing assertion, not the shape checks around it: `NOT
    // hasActivePaidAccess EXISTS` would satisfy every property below and hide the wrong documents.
    expect(HIDE_PAID_MODELS_FILTER).toBe('NOT hasActivePaidAccess = true');
  });

  it('survives the parenthesising every clause gets before it reaches Meilisearch', () => {
    // joinFilterClauses wraps each clause in `(...)`. A clause only valid unwrapped would fail as a
    // 400 at runtime and never in a unit test that looked at the constant alone.
    expect(joinFilterClauses([HIDE_PAID_MODELS_FILTER])).toBe('(NOT hasActivePaidAccess = true)');
  });

  it('filters on an attribute the models index declares filterable', () => {
    // Without this the whole models search answers 400 invalid_search_filter the moment anyone
    // ticks the box — not just the paid filter, the entire result set.
    expect(filterableAttributesByIndex[MODELS_SEARCH_INDEX]).toContain('hasActivePaidAccess');
  });
});

describe('paidModelsSearchFilterClause', () => {
  it('applies the clause only when the flag is on AND the box is ticked', () => {
    expect(paidModelsSearchFilterClause(true, true)).toBe(HIDE_PAID_MODELS_FILTER);
  });

  it('emits nothing when the feature flag is off, whatever the box says', () => {
    // Dropping the flag from the gate would ship the filter to everyone before the index settings
    // and the backfill land, which breaks the entire models search rather than just this filter.
    expect(paidModelsSearchFilterClause(false, true)).toBeNull();
  });

  it('emits nothing when the box is unticked — paid models are shown by DEFAULT', () => {
    // A default of `true` would silently remove paid models from everyone's search.
    expect(paidModelsSearchFilterClause(true, false)).toBeNull();
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

// Each alternative is a spelling that is valid Meilisearch and matches only documents that HAVE the
// attribute. `= false` is the obvious one; `!= true` reads as the opposite but excludes absent
// documents the same way, and the attribute may be quoted.
const FORBIDDEN = /"?hasActivePaidAccess"?\s*(=\s*false|!=\s*true)/;

describe('no equality-on-present-only spelling anywhere', () => {
  it('src/ never writes hasActivePaidAccess as an equality that skips absent documents', () => {
    const offenders = walk(path.join(repoRoot, 'src'))
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWLIST.includes(file as (typeof ALLOWLIST)[number]));

    expect(ALLOWLIST).toHaveLength(1);
    expect(
      offenders,
      'Use a NOT clause. An equality does not match documents that lack the attribute.'
    ).toEqual([]);
  });

  it('the call site actually WIRES the clause in, not merely imports it', () => {
    // `toContain('HIDE_PAID_MODELS_FILTER')` was satisfied by the import line alone, so deleting the
    // clause from the filters array left every suite green while the checkbox did nothing. Pin the
    // call, which the import cannot satisfy.
    const source = readFileSync(path.join(repoRoot, CALL_SITE), 'utf8');

    expect(source).toContain(
      'paidModelsSearchFilterClause(features.paidModelSearchFilter, hidePaid)'
    );
    expect(source).not.toMatch(/['"`]NOT hasActivePaidAccess/);
  });

  it('shows paid models by DEFAULT — the box starts unticked', () => {
    // The helper test covers "unticked emits nothing", but nothing read the initial value, so
    // useState(true) — every user's model search silently losing paid models — was invisible.
    const source = readFileSync(path.join(repoRoot, CALL_SITE), 'utf8');

    expect(source).toContain('const [hidePaid, setHidePaid] = useState(false)');
  });
});
