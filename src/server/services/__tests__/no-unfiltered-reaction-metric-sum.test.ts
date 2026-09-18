import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A metric job that SUMs a reaction table must exclude the metric-suppressed accounts.
 *
 * Every ClickHouse path that produces a reaction total already filters
 * `metricExcludedUsers`. The Postgres metric jobs did not, so the number a viewer sees
 * on a post, article or bounty entry counted accounts the platform had already decided
 * not to count — measured at 594 articles / 1,438 reactions and 1,154 bounty entries /
 * 1,666 reactions, with the post population bounded below at 133,961.
 *
 * It is pinned textually because nothing in the test suite executes this SQL: the
 * queries are template literals handed to `pg`, so a deleted `${excludedFilter}` is
 * invisible to the typechecker, to lint, and to every suite. The thing under test is
 * the text.
 *
 * 🔴 If you are about to delete this: the unfiltered sum is not a stale value that a
 * re-run heals. `PostMetric`/`ArticleMetric`/`BountyEntryMetric` are recomputed from
 * the same Postgres rows every time, so an unfiltered total is permanent until the
 * query itself filters.
 */

const metricsDir = path.resolve(__dirname, '../../metrics');
const repoRoot = path.resolve(__dirname, '../../../..');

/**
 * Reaction tables whose metric job is NOT expected to filter, with the reason. Both
 * belong to the retired Q&A feature and neither surfaces on a browsable feed, so they
 * were left out of the scope this guard was written for rather than overlooked.
 *
 * The list's length is asserted below: adding a table here has to be a visible change,
 * because an exemption is how the same defect gets written again unseen.
 */
const EXEMPT_TABLES = ['AnswerReaction', 'QuestionReaction'] as const;

/** The call sites this guard expects to find. A regex that matches nothing passes every
 *  prohibition in this file, so the set it discovered is asserted before it is judged. */
const EXPECTED_SITES = [
  'article.metrics.ts:ArticleReaction',
  'bountyEntry.metrics.ts:BountyEntryReaction',
  'post.metrics-old.ts:ImageReaction',
  'post.metrics.ts:ImageReaction',
] as const;

type Site = { file: string; table: string; literal: string };

/** Odd-indexed chunks of a backtick split are the template literals. */
function templateLiterals(text: string) {
  return text.split('`').filter((_, i) => i % 2 === 1);
}

const sites: Site[] = [];
for (const file of readdirSync(metricsDir).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(path.join(metricsDir, file), 'utf8');
  for (const literal of templateLiterals(text)) {
    // A query that only locates affected ids needs no filter — counting an excluded
    // user's reaction as "this entity changed" is harmless, because the recompute that
    // follows is the thing that must exclude them. What must filter is a query that
    // turns reaction rows into a number.
    const aggregates = /\bSUM\s*\(/.test(literal) || literal.includes('reactionTimeframes');
    if (!aggregates) continue;
    for (const [, table] of literal.matchAll(/FROM\s+"(\w+Reaction)"/g)) {
      sites.push({ file, table, literal });
    }
  }
}

const key = (s: Site) => `${s.file}:${s.table}`;

describe('no unfiltered reaction metric sum', () => {
  it('found the reaction aggregates it is meant to judge', () => {
    // Without this the file is vacuous: every assertion below is a prohibition, and a
    // scan that discovers nothing satisfies all of them.
    const found = [...new Set(sites.map(key))].sort();
    const expected = [
      ...EXPECTED_SITES,
      'answer.metrics.ts:AnswerReaction',
      'question.metrics.ts:QuestionReaction',
    ].sort();

    expect(
      found,
      'The scan no longer finds the reaction aggregates this guard exists to cover. ' +
        'A metric job was renamed, moved, or rewritten — fix the scan, do not delete the guard.'
    ).toEqual(expected);
  });

  it('the exemption list is two tables — widening it must be a visible change', () => {
    expect(EXEMPT_TABLES).toHaveLength(2);
  });

  it('every reaction aggregate splices the exclusion filter', () => {
    const offenders = sites
      .filter((s) => !EXEMPT_TABLES.includes(s.table as (typeof EXEMPT_TABLES)[number]))
      .filter((s) => !s.literal.includes('${excludedFilter}'))
      .map(key);

    expect(
      offenders,
      'These queries sum a reaction table without splicing `${excludedFilter}`, so the ' +
        'count a viewer sees includes metric-suppressed accounts. Build the snippet with ' +
        '`snippets.excludedReactorFilter(await getMetricExcludedUserIdsOrThrow(), ...)`.'
    ).toEqual([]);
  });

  it('every filtering job reads the list through the throwing variant', () => {
    // `getMetricExcludedUserIds` degrades to `[]` on a failed read, which is right for a
    // notification and wrong here: it would write an unfiltered total that no later run
    // recomputes. The names differ by a suffix, so match the lenient one only when
    // `OrThrow` does not follow it.
    const offenders = [...new Set(sites.filter((s) => !EXEMPT_TABLES.includes(s.table as never)))]
      .map((s) => s.file)
      .filter((file, i, all) => all.indexOf(file) === i)
      .filter((file) => {
        const text = readFileSync(path.join(metricsDir, file), 'utf8');
        return (
          !text.includes('getMetricExcludedUserIdsOrThrow') ||
          /getMetricExcludedUserIds(?!OrThrow)/.test(text)
        );
      });

    expect(
      offenders,
      'These jobs must read the exclusion list with `getMetricExcludedUserIdsOrThrow`, and ' +
        'must not use the lenient reader. A lenient read turns a ClickHouse outage into a ' +
        'permanently unfiltered total, because the metric jobs only ever revisit an entity ' +
        'that receives another reaction.'
    ).toEqual([]);
  });

  it('the strict reader still exists under that name', () => {
    // The prohibitions above are all satisfied by deleting the feature. This is the one
    // assertion that fails if the reader is renamed away rather than misused.
    const service = readFileSync(
      path.join(repoRoot, 'src/server/services/metric-excluded-users.service.ts'),
      'utf8'
    );
    expect(service).toContain('export async function getMetricExcludedUserIdsOrThrow');
  });
});
