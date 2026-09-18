import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Anything that turns reaction rows into a number must exclude the metric-suppressed
 * accounts — the displayed metric AND the milestone notification for the same entity.
 *
 * Every ClickHouse path that produces a reaction total already filters them. The
 * Postgres sums did not, so the number a viewer saw on a post, article or bounty entry
 * counted accounts the platform had already decided not to count. Fixing only the
 * displayed half would have been worse than fixing neither: the milestone would then
 * congratulate a creator on a number their own page never shows, which is the defect
 * this one is a sibling of.
 *
 * It is pinned textually because nothing in the suite executes this SQL: the queries are
 * template literals handed to `pg`, so a deleted `${excludedFilter}` is invisible to the
 * typechecker, to lint and to every suite. The thing under test is the text.
 *
 * 🔴 If you are about to delete this: the unfiltered sum is not a stale value that a
 * re-run heals. The metric tables are recomputed from the same Postgres rows every time,
 * so an unfiltered total is permanent until the query itself filters.
 *
 * What this guard does NOT do, stated so a green run is not over-read: it ratchets the
 * call sites listed in EXPECTED_SITES. A reaction total written in a shape the scan does
 * not recognise, or in a directory it does not read, is not covered — rewriting an
 * existing site into such a shape goes red, but a brand new one does not.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

/**
 * Two directories, two different correct readers, so the scan carries which is which.
 *
 * A metric job must use the throwing reader: it writes a total that nothing later
 * recomputes, so degrading to an unfiltered count on a failed read would be permanent.
 * A notification must use the lenient one: degrading to the pre-exclusion count is how
 * it behaved before, and the alternative is a milestone that silently never fires.
 */
const SCOPES = [
  { dir: 'src/server/metrics', reader: 'getMetricExcludedUserIdsOrThrow' },
  { dir: 'src/server/notifications', reader: 'getMetricExcludedUserIds' },
] as const;

/**
 * Reaction tables whose count is NOT expected to filter, with the reason. Both belong to
 * the retired Q&A feature and neither surfaces on a browsable feed, so they were left
 * out of the scope this guard was written for rather than overlooked.
 *
 * The list's length is asserted below: adding a table here has to be a visible change,
 * because an exemption is how the same defect gets written again unseen.
 */
const EXEMPT_TABLES = ['AnswerReaction', 'QuestionReaction'] as const;

/**
 * The call sites this guard expects to find. A regex that matches nothing passes every
 * prohibition in this file, so the set it discovered is asserted before it is judged.
 */
const EXPECTED_SITES = [
  'src/server/metrics/article.metrics.ts:ArticleReaction',
  'src/server/metrics/bountyEntry.metrics.ts:BountyEntryReaction',
  'src/server/metrics/post.metrics-old.ts:ImageReaction',
  'src/server/metrics/post.metrics.ts:ImageReaction',
  'src/server/notifications/bounty.notifications.ts:BountyEntryReaction',
  'src/server/notifications/reaction.notifications.ts:ArticleReaction',
] as const;

/**
 * Sites left unfiltered on purpose, each with the reason it is not a divergence.
 *
 * The two Q&A ones are the retired feature. The comment milestone is different: the
 * displayed comment reaction count is not filtered either, so the pair still AGREES.
 * Filtering one half is what creates the defect this guard exists for, so the comment
 * milestone moves when the comment display does, not before.
 */
const EXEMPT_SITES = [
  'src/server/metrics/answer.metrics.ts:AnswerReaction',
  'src/server/metrics/question.metrics.ts:QuestionReaction',
  'src/server/notifications/reaction.notifications.ts:CommentReaction',
] as const;

type Site = { rel: string; table: string; literal: string; reader: string };

/** Odd-indexed chunks of a backtick split are the template literals. */
function templateLiterals(text: string) {
  return text.split('`').filter((_, i) => i % 2 === 1);
}

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const sites: Site[] = [];
const fileText = new Map<string, string>();
for (const scope of SCOPES) {
  for (const full of walk(path.join(repoRoot, scope.dir))) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    const text = readFileSync(full, 'utf8');
    fileText.set(rel, text);
    for (const literal of templateLiterals(text)) {
      // A query that only locates affected ids needs no filter — counting an excluded
      // user's reaction as "this entity changed" is harmless, because the recompute that
      // follows is the thing that must exclude them. What must filter is a query that
      // turns reaction rows into a number.
      // `reactionTimeframes` is an interpolation, so a job using it has no literal
      // `SUM(` in its own text — matching only SUM/COUNT silently dropped two sites.
      const counts = /\b(SUM|COUNT)\s*\(/i.test(literal) || literal.includes('reactionTimeframes');
      if (!counts) continue;
      // FROM *or* JOIN: the bounty-entry job drives from the affected ids and reaches the
      // reaction table through a LEFT JOIN, so a FROM-only match loses exactly the site
      // whose shape changed most.
      for (const [, table] of literal.matchAll(/(?:FROM|JOIN)\s+"(\w+Reaction)"/g)) {
        sites.push({ rel, table, literal, reader: scope.reader });
      }
    }
  }
}

const key = (s: Site) => `${s.rel}:${s.table}`;
const isExempt = (s: Site) =>
  (EXEMPT_TABLES as readonly string[]).includes(s.table) ||
  (EXEMPT_SITES as readonly string[]).includes(key(s));
const covered = sites.filter((s) => !isExempt(s));

describe('no unfiltered reaction count', () => {
  it('found the reaction aggregates it is meant to judge', () => {
    // Without this the file is vacuous: every assertion below is a prohibition, and a
    // scan that discovers nothing satisfies all of them.
    const found = [...new Set(sites.map(key))].sort();
    const expected = [...EXPECTED_SITES, ...EXEMPT_SITES].sort();

    expect(
      found,
      'The scan no longer finds the reaction counts this guard exists to cover. A job or ' +
        'notification was renamed, moved, or rewritten — fix the scan, do not delete the guard.'
    ).toEqual(expected);
  });

  it('the exemption list is two tables — widening it must be a visible change', () => {
    expect(EXEMPT_TABLES).toHaveLength(2);
  });

  it('every reaction count splices the exclusion filter', () => {
    const offenders = covered.filter((s) => !s.literal.includes('${excludedFilter}')).map(key);

    expect(
      offenders,
      'These queries count a reaction table without splicing `${excludedFilter}`, so the ' +
        'number a viewer sees includes metric-suppressed accounts. Build the snippet with ' +
        '`snippets.excludedReactorFilter(...)`.'
    ).toEqual([]);
  });

  it('no splice is commented out', () => {
    // `literal.includes(...)` is satisfied by `-- ${excludedFilter}`, which Postgres
    // applies as nothing. Measured as a green mutation before this assertion existed.
    const offenders = covered
      .filter((s) =>
        s.literal
          .split('\n')
          .some(
            (line) =>
              line.includes('${excludedFilter}') && /--[^\n]*\$\{excludedFilter\}/.test(line)
          )
      )
      .map(key);

    expect(
      offenders,
      'The exclusion filter is inside an SQL line comment in these queries, so it is spliced ' +
        'into the statement and then ignored.'
    ).toEqual([]);
  });

  it('every filtering file reads the list through the reader its scope requires', () => {
    // The two readers differ by a suffix, so the lenient one is matched only where
    // `OrThrow` does not follow it.
    const offenders = [...new Set(covered.map((s) => s.rel))]
      .map((rel) => ({ rel, site: covered.find((s) => s.rel === rel)! }))
      .filter(({ rel, site }) => {
        const text = fileText.get(rel)!;
        if (site.reader === 'getMetricExcludedUserIdsOrThrow') {
          return (
            !text.includes('getMetricExcludedUserIdsOrThrow') ||
            /getMetricExcludedUserIds(?!OrThrow)/.test(text)
          );
        }
        return (
          !/getMetricExcludedUserIds(?!OrThrow)/.test(text) ||
          text.includes('getMetricExcludedUserIdsOrThrow')
        );
      })
      .map(({ rel }) => rel);

    expect(
      offenders,
      'A metric job must read the list with `getMetricExcludedUserIdsOrThrow` — a lenient read ' +
        'turns an outage into a permanently unfiltered total, because the jobs only revisit an ' +
        'entity that receives another reaction. A notification must read it with the lenient ' +
        '`getMetricExcludedUserIds`, so a failed read degrades to the old count rather than to ' +
        'no notification.'
    ).toEqual([]);
  });

  it('no file swallows the strict read', () => {
    // `getMetricExcludedUserIdsOrThrow().catch(() => [])` restores the whole defect while
    // satisfying every name-based assertion above. Measured as a green mutation before
    // this existed.
    const offenders = [...new Set(covered.map((s) => s.rel))].filter((rel) =>
      /getMetricExcludedUserIdsOrThrow\s*\([^)]*\)\s*\.\s*catch/.test(fileText.get(rel)!)
    );

    expect(
      offenders,
      'These files catch the strict read, which is the lenient reader written the long way. ' +
        'If the list cannot be read, the run must fail so the cursor does not advance.'
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
