import { describe, expect, it, vi } from 'vitest';
import { snippets } from '~/server/metrics/metric-helpers';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  buildSql,
  digestOf,
  fetchExcludedUserIds,
  parseArgs,
  planRanges,
  reactionAssignments,
  specs,
  sqlFor,
  timeframedReactionSums,
} from '../oneoffs/backfill-reaction-metric-exclusions';

/**
 * The only test that reads the SQL this backfill sends, and the only thing standing
 * between a dry run and a production write.
 *
 * `PrismaClient` is never constructed here — everything under test is a pure builder, so
 * the SQL can be read without a database.
 */

const EXCLUDED = '11,22';
const range = { start: 0, end: 100, excluded: EXCLUDED };
const dry = (entity: keyof typeof specs) => buildSql(specs[entity], range).dry;
const write = (entity: keyof typeof specs) => buildSql(specs[entity], range).write;

/**
 * Whitespace, the `::int` cast and the `AS` before an alias are not semantics. Everything
 * else is compared byte for byte — this deliberately does NOT normalise away operators,
 * intervals, quoting or the reaction names, because those are the transcription.
 */
const normalise = (sql: string) =>
  sql
    .replace(/::int/g, '')
    .replace(/\)\s+AS\s+"/g, ') "')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();

describe('reaction-metric exclusion backfill', () => {
  describe('the timeframe transcription', () => {
    /**
     * Named for the decision. `timeframedReactionSums` is a hand transcription of
     * `snippets.reactionTimeframes()`, copied because importing metric-helpers into a
     * standalone script drags in the Flipt client and the whole metric graph. A copy that
     * nothing compares is a copy that drifts, so this is the comparison. If it fails,
     * re-transcribe — do not relax it.
     */
    it('is character-identical to the snippet the bountyEntry job uses', () => {
      expect(normalise(timeframedReactionSums)).toBe(normalise(snippets.reactionTimeframes()));
    });

    it('differs from the AllTime-only sums — the control for the assertion above', () => {
      // Without this, a transcription that collapsed to the AllTime arm would compare
      // equal to a snippet that had done the same, and the parity check would be vacuous.
      expect(normalise(timeframedReactionSums)).not.toBe(
        normalise(specs.article.ctes(range).match(/SUM\(CASE[\s\S]*?cryCount"/)?.[0] ?? '')
      );
      for (const timeframe of ['Year', 'Month', 'Week', 'Day']) {
        expect(timeframedReactionSums, `the ${timeframe} window is missing`).toContain(
          `tf.timeframe = '${timeframe}'`
        );
      }
    });

    it('scores an outer-joined row as 0 rather than letting it reach the AllTime arm', () => {
      // `IS NOT TRUE`, not `NOT (...)`: under the LEFT JOIN an unmatched row makes the
      // condition NULL, and NULL would fall through and count a reaction that is not there.
      for (const reaction of Object.keys(ReviewReactions)) {
        expect(timeframedReactionSums).toContain(`WHEN (r.reaction = '${reaction}') IS NOT TRUE`);
      }
    });
  });

  describe('the guard between a dry run and a production write', () => {
    /**
     * Named for the decision. `sqlFor` and `parseArgs` exist as separate exported
     * functions ONLY so these assertions can reach them, and inlining either back into
     * `main` is the obvious tidy-up. Do not: with the choice inlined, replacing
     * `write ? sql.write : sql.dry` with `sql.write` left all 21 tests green, because
     * nothing in the suite executes `main`. A dry run that writes to production is the
     * worst failure this script has, and it was the one thing nothing could see.
     */
    it('issues the SELECT unless asked to write', () => {
      const dryRun = sqlFor(specs.article, range, false);

      expect(dryRun, 'a dry run issued an UPDATE').not.toMatch(/UPDATE|RETURNING/);
      expect(dryRun).toMatch(/SELECT m\."articleId"/);
    });

    it('issues the UPDATE when asked — the control for the assertion above', () => {
      const real = sqlFor(specs.article, range, true);

      expect(real).toMatch(/UPDATE "ArticleMetric" m/);
      expect(real).toMatch(/RETURNING/);
    });

    it('defaults to a dry run with no arguments at all', () => {
      const opts = parseArgs(['node', 'script.ts']);

      expect(opts.write, 'the bare invocation writes to production').toBe(false);
      expect(opts.propagate).toBe(false);
      expect(opts.entities).toEqual(['article', 'bountyEntry']);
      expect(opts.batchSize).toBe(10000);
    });

    it('writes only when --write is given', () => {
      expect(parseArgs(['node', 's.ts', '--write']).write).toBe(true);
    });

    it('refuses to propagate without --write, however it is asked', () => {
      // Propagation busts the production article cache and queues a production reindex,
      // and the app's .env points both at production whichever database is configured —
      // so a dry run against a dev database must not reach them.
      expect(parseArgs(['node', 's.ts', '--propagate']).propagate).toBe(false);
      expect(parseArgs(['node', 's.ts', '--propagate', '--write']).propagate).toBe(true);
    });

    it('rejects an unknown entity rather than silently running all of them', () => {
      expect(() => parseArgs(['node', 's.ts', '--entity', 'post'])).toThrow('--entity must be one');
      expect(parseArgs(['node', 's.ts', '--entity', 'article']).entities).toEqual(['article']);
    });
  });

  describe('dry run vs write', () => {
    it('runs the identical scan, and only the write mutates', () => {
      const { dry: d, write: w } = buildSql(specs.article, range);

      expect(d, 'the dry run is not a SELECT').toMatch(/^\s*WITH[\s\S]*SELECT m\."articleId"/);
      expect(d, 'the dry run writes').not.toMatch(/UPDATE|SET |RETURNING/);
      expect(w).toMatch(/UPDATE "ArticleMetric" m/);
    });

    it('scans the same CTEs in both modes', () => {
      const cte = specs.article.ctes(range);

      expect(normalise(dry('article'))).toContain(normalise(cte));
      expect(normalise(write('article'))).toContain(normalise(cte));
    });
  });

  describe('the exclusion filter', () => {
    it('filters the REACTOR on both sides, for every entity', () => {
      // Deleting the `NOT IN` from the sums join makes the computed sum equal the stored
      // one, so nothing differs, nothing is written, and the run reports a clean sweep
      // having done nothing. That is the failure this whole script exists to prevent.
      const cases = [
        { entity: 'article', table: '"ArticleReaction"' },
        { entity: 'bountyEntry', table: '"BountyEntryReaction"' },
      ] as const;

      for (const c of cases) {
        const sql = dry(c.entity);
        const references = sql.match(new RegExp(c.table, 'g')) ?? [];
        const filters = sql.match(/"userId" (?:NOT )?IN \(11,22\)/g) ?? [];

        expect(
          filters.length,
          `${c.entity}: ${references.length} refs, ${filters.length} filters`
        ).toBe(references.length);
        expect(sql, `${c.entity} does not exclude the reactors from its sum`).toContain(
          `AND r."userId" NOT IN (${EXCLUDED})`
        );
        expect(sql, `${c.entity} does not find affected entities by the reactor`).toContain(
          `AND r."userId" IN (${EXCLUDED})`
        );
      }
    });
  });

  describe('what gets written, not which row gets selected', () => {
    it('assigns each column from its OWN computed sum', () => {
      for (const reaction of Object.keys(ReviewReactions)) {
        const column = reaction.toLowerCase();
        expect(reactionAssignments, `${column}Count is not assigned from its own sum`).toContain(
          `"${column}Count" = s."${column}Count"`
        );
      }
    });

    it('sums each reaction from its OWN name', () => {
      const sql = dry('article');

      for (const reaction of Object.keys(ReviewReactions)) {
        expect(sql, `${reaction} is not summed from its own name`).toContain(
          `SUM(CASE WHEN r.reaction = '${reaction}' THEN 1 ELSE 0 END)::int AS "${reaction.toLowerCase()}Count"`
        );
      }
    });

    it('compares every reaction column before writing anything', () => {
      for (const reaction of Object.keys(ReviewReactions)) {
        const column = reaction.toLowerCase();
        expect(write('article'), `${column}Count is not compared`).toContain(
          `m."${column}Count" IS DISTINCT FROM s."${column}Count"`
        );
      }
    });

    it('aims each entity at its own metric table and its own reaction table', () => {
      expect(write('article')).toContain('UPDATE "ArticleMetric" m');
      expect(write('article')).toContain('"ArticleReaction"');
      expect(specs.article.maxIdSql).toContain('FROM "Article"');

      expect(write('bountyEntry')).toContain('UPDATE "BountyEntryMetric" m');
      expect(write('bountyEntry')).toContain('"BountyEntryReaction"');
      expect(specs.bountyEntry.maxIdSql).toContain('FROM "BountyEntry"');
    });

    it('scopes article to AllTime and bountyEntry to the matching timeframe', () => {
      expect(write('article')).toContain(`m.timeframe = 'AllTime'`);
      expect(write('bountyEntry')).toContain('m.timeframe = s.timeframe');
      expect(write('bountyEntry'), 'bountyEntry was pinned to AllTime').not.toContain(
        `m.timeframe = 'AllTime'`
      );
    });

    it('generates all five timeframes for bountyEntry', () => {
      // The timeframe MATCH being right says nothing about the timeframe VALUES.
      expect(dry('bountyEntry')).toContain(`unnest(enum_range(NULL::"MetricTimeframe"))`);
    });

    it('stamps updatedAt on every row it writes', () => {
      expect(write('article')).toContain('"updatedAt" = NOW()');
      expect(write('bountyEntry')).toContain('"updatedAt" = NOW()');
    });
  });

  describe('range planning', () => {
    it('is inclusive at both ends and gapless', () => {
      const ranges = planRanges(0, 25, 10);

      expect(ranges).toEqual([
        [0, 9],
        [10, 19],
        [20, 25],
      ]);
    });

    it("bounds the statement with >= and <=, not the template's > start", () => {
      expect(dry('article')).toMatch(/r\."articleId" >= 0 AND r\."articleId" <= 100/);
      expect(dry('bountyEntry')).toMatch(/r\."bountyEntryId" >= 0 AND r\."bountyEntryId" <= 100/);
    });

    it('emits nothing for a transposed range rather than silently walking it', () => {
      expect(planRanges(20000000, 2000000, 10000)).toEqual([]);
    });
  });

  describe('the exclusion list', () => {
    it('is stable under reordering and changes with the list', () => {
      // The list moved 557 -> 571 mid-flight. Without the digest, a residual that does not
      // match an earlier run cannot be told from a list that grew underneath it.
      expect(digestOf([22, 11])).toBe(digestOf([11, 22]));
      expect(digestOf([11, 23])).not.toBe(digestOf([11, 22]));
    });

    it('THROWS on an empty list rather than running', async () => {
      // An empty list makes every computed sum equal its stored value, so the run would
      // rewrite nothing and report a clean sweep. Failing open here is indistinguishable
      // from success.
      vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test');
      vi.stubEnv('CLICKHOUSE_USERNAME', 'tester');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }))
      );

      await expect(fetchExcludedUserIds()).rejects.toThrow('exclusion list is empty');
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('returns the ids when the list is populated — the control for the above', async () => {
      vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test');
      vi.stubEnv('CLICKHOUSE_USERNAME', 'tester');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ data: [[11], [22]] }) }))
      );

      await expect(fetchExcludedUserIds()).resolves.toEqual([11, 22]);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('THROWS when ClickHouse answers non-ok', async () => {
      vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test');
      vi.stubEnv('CLICKHOUSE_USERNAME', 'tester');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }))
      );

      await expect(fetchExcludedUserIds()).rejects.toThrow('clickhouse 503');
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('drops a null userId rather than suppressing user 0', async () => {
      vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test');
      vi.stubEnv('CLICKHOUSE_USERNAME', 'tester');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ data: [[11], [null], [22]] }) }))
      );

      await expect(fetchExcludedUserIds()).resolves.toEqual([11, 22]);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
  });
});
