import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { snippets } from '~/server/metrics/metric-helpers';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  affectedSql,
  buildSql,
  collectAffected,
  describeTarget,
  digestOf,
  fetchExcludedUserIds,
  parseArgs,
  planRanges,
  propagateArticles,
  propagationTarget,
  reactionAssignments,
  runEntity,
  specs,
  sqlFor,
  timeframedReactionSums,
} from '../oneoffs/backfill-reaction-metric-exclusions';

/**
 * The only test that reads the SQL this backfill sends, and the only thing standing
 * between a dry run and a production write.
 *
 * 🔴 The lesson this file is built around: it is not enough to test the pure builders.
 * An earlier revision moved the dry/write CHOICE into a tested function and left the
 * CALL SITE in `main()`, where mutating it to a literal `true` still passed every
 * assertion. `runEntity` and `propagateArticles` therefore take an injected executor and
 * fetch, so a test can assert what a run actually ISSUES rather than what it could build.
 *
 * Note for anyone adding to this file: none of the repo's mock ratchets reach here.
 * `no-direct-shared-module-mock` and `pgDbMock.parity` glob `src/` only, and `pnpm lint`
 * is `eslint src/`, so `scripts/` is not linted at all. The belts you are used to are not
 * fastened in this directory.
 */

const SCRIPT = path.join(process.cwd(), 'scripts/oneoffs/backfill-reaction-metric-exclusions.ts');
const EXCLUDED = '11,22';
const range = { start: 0, end: 100, excluded: EXCLUDED };
const dry = (entity: keyof typeof specs) => buildSql(specs[entity], range).dry;
const write = (entity: keyof typeof specs) => buildSql(specs[entity], range).write;
const ENTITIES = ['article', 'bountyEntry'] as const;

/**
 * Whitespace, the `::int` cast and an `AS` that directly follows `)` are not semantics.
 * Everything else is compared byte for byte — operators, intervals, quoting, reaction
 * names and the `IS NOT TRUE` arm are the transcription and are deliberately NOT
 * normalised away.
 */
const normalise = (sql: string) =>
  sql
    .replace(/::int/g, '')
    .replace(/\)\s+AS\s+"/g, ') "')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();

/** Records every statement a run issues, and answers with whatever rows the test wants. */
function fakeExec(rowsFor: (sql: string) => { id: number }[] = () => []) {
  const issued: string[] = [];
  const exec = vi.fn(async (sql: string) => {
    issued.push(sql);
    return rowsFor(sql);
  });
  return { exec, issued };
}

const ranges: Array<[number, number]> = [
  [0, 9],
  [10, 19],
];

describe('reaction-metric exclusion backfill', () => {
  describe('what a run ACTUALLY issues', () => {
    /**
     * Named for the decision. `runEntity` takes its executor as an argument ONLY so these
     * assertions exist; folding it back into `main` is the obvious tidy-up. Do not. The
     * previous revision tested `sqlFor` in isolation and a one-word mutation of its CALL
     * SITE — `sqlFor(spec, args, true)` — issued production UPDATEs with all 29 tests
     * green, because nothing in the suite executed the function the call site lived in.
     */
    it.each(ENTITIES)('issues no UPDATE for %s unless asked to write', async (entity) => {
      const { exec, issued } = fakeExec();

      await runEntity({ exec, spec: specs[entity], excluded: EXCLUDED, write: false, ranges });

      expect(issued).toHaveLength(2);
      for (const sql of issued) {
        expect(sql, `a dry run issued a mutating statement for ${entity}`).not.toMatch(
          /UPDATE|RETURNING/
        );
      }
    });

    it.each(ENTITIES)('issues the UPDATE for %s when asked — the control', async (entity) => {
      const { exec, issued } = fakeExec();

      await runEntity({ exec, spec: specs[entity], excluded: EXCLUDED, write: true, ranges });

      expect(issued).toHaveLength(2);
      for (const sql of issued) expect(sql).toMatch(/UPDATE|RETURNING/);
    });

    it('issues one statement per range, bounded by that range', async () => {
      const { exec, issued } = fakeExec();

      await runEntity({ exec, spec: specs.article, excluded: EXCLUDED, write: false, ranges });

      expect(issued[0]).toContain('r."articleId" >= 0 AND r."articleId" <= 9');
      expect(issued[1]).toContain('r."articleId" >= 10 AND r."articleId" <= 19');
    });

    it('returns the changed ids, deduplicated', async () => {
      const { exec } = fakeExec(() => [{ id: 3 }, { id: 3 }, { id: 9 }]);

      const { ids: changed } = await runEntity({
        exec,
        spec: specs.article,
        excluded: EXCLUDED,
        write: true,
        ranges,
      });

      expect(changed).toEqual([3, 9]);
    });

    it('counts ROWS and IDS separately, because for bountyEntry they differ by 5x', async () => {
      // bountyEntry writes one row per timeframe, so the UPDATE returns the same id five
      // times. Reporting the deduplicated count under the word "rows" understated a dev
      // run's write by exactly that factor — 10 rows reported as 2 — and it was a
      // deliberately-corrupted control that caught it, not the suite.
      const { exec } = fakeExec(() => [{ id: 5 }, { id: 5 }, { id: 5 }, { id: 6 }]);

      const { rows, ids } = await runEntity({
        exec,
        spec: specs.bountyEntry,
        excluded: EXCLUDED,
        write: true,
        ranges,
      });

      expect(rows, 'the row count was deduplicated').toBe(8);
      expect(ids, 'the id set was not deduplicated').toEqual([5, 6]);
    });

    it('carries a failed batch instead of aborting the ones after it', async () => {
      // The batches before a failure are already committed. Letting the error escape
      // ends the run with rows written and no record of which — and a re-run cannot
      // recover them, because IS DISTINCT FROM never selects them again.
      let call = 0;
      const { exec } = fakeExec(() => {
        call++;
        if (call === 1) throw new Error('canceling statement due to statement timeout');
        return [{ id: 7 }];
      });

      const { ids: changed, failures } = await runEntity({
        exec,
        spec: specs.article,
        excluded: EXCLUDED,
        write: true,
        ranges,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0].range).toEqual([0, 9]);
      expect(failures[0].message).toContain('statement timeout');
      expect(changed, 'the batch after the failure did not run').toEqual([7]);
    });

    it('reports no failures on a clean run — the control for the above', async () => {
      const { exec } = fakeExec(() => [{ id: 7 }]);

      const { failures } = await runEntity({
        exec,
        spec: specs.article,
        excluded: EXCLUDED,
        write: false,
        ranges,
      });

      expect(failures).toEqual([]);
    });
  });

  describe('propagation reads the AFFECTED set, not what changed', () => {
    /**
     * Named for the decision. Driving propagation from the rows a run wrote looks
     * equivalent and is not: the ordinary operator flow is `--write`, read the numbers,
     * then `--write --propagate`, and by the second run nothing differs so nothing would
     * be queued. Same after an interrupted run. Re-queueing an already-correct article
     * is a no-op; failing to queue a corrected one is permanent.
     */
    it('asks for the affected ids with a statement that never mutates', async () => {
      const { exec, issued } = fakeExec(() => [{ id: 5 }, { id: 5 }, { id: 6 }]);

      const ids = await collectAffected({ exec, spec: specs.article, excluded: EXCLUDED, ranges });

      expect(ids).toEqual([5, 6]);
      for (const sql of issued) {
        expect(sql).toContain('SELECT id FROM affected');
        expect(sql).not.toMatch(/UPDATE|RETURNING/);
      }
    });

    it('finds ids even when the run changed nothing', async () => {
      // The second `--write --propagate` run: zero rows written, ids still needed.
      // Discriminated on the affected statement's own tail: `FROM affected a` also
      // appears inside the sums CTE of the write statement, so the looser match answers
      // both and the test stops being about anything.
      const { exec } = fakeExec((sql) =>
        sql.includes('SELECT id FROM affected') ? [{ id: 5 }] : []
      );

      const { ids: changed } = await runEntity({
        exec,
        spec: specs.article,
        excluded: EXCLUDED,
        write: true,
        ranges,
      });
      const affected = await collectAffected({
        exec,
        spec: specs.article,
        excluded: EXCLUDED,
        ranges,
      });

      expect(changed).toEqual([]);
      expect(affected, 'propagation would have queued nothing').toEqual([5]);
    });

    it('carries the exclusion filter into the affected statement too', () => {
      const sql = affectedSql(specs.article, range);

      expect(sql).toContain(`AND r."userId" IN (${EXCLUDED})`);
    });

    it('is wired only for article, on the spec rather than in the loop', () => {
      // bountyEntry.metrics.ts busts no cache and queues no index, so there is nothing
      // downstream to tell. Carried on the spec because an `entity === 'article'` test in
      // the loop body would, if dropped, POST bountyEntry ids to an article reindex.
      expect(specs.article.propagate).toBeTypeOf('function');
      expect(specs.bountyEntry.propagate).toBeUndefined();
    });
  });

  describe('propagateArticles', () => {
    beforeEach(() => {
      vi.stubEnv('INTERNAL_BASE_URL', 'https://example.test');
      vi.stubEnv('WEBHOOK_TOKEN', 'tok');
    });

    const okFetch = () =>
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        // The clear endpoint answers with the number of keys it removed, and the script
        // reads it back — a `cleared: 0` is what a wrong key shape looks like.
        json: async () => ({ ok: true, cleared: 1 }),
      })) as unknown as typeof fetch;

    it('queues every id, in batches the endpoint will accept', async () => {
      // The endpoint caps entityIds at 1000. A slice bug here queues the first batch and
      // then empty ones, logging "queued 0" each time — permanent, since the job never
      // revisits these rows.
      const f = okFetch();
      const ids = Array.from({ length: 2300 }, (_, i) => i + 1);

      await propagateArticles(ids, f);

      const posts = (
        f as unknown as { mock: { calls: [string, RequestInit][] } }
      ).mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(3);
      const queued = posts.flatMap(([, init]) => JSON.parse(String(init.body)).entityIds);
      expect(queued).toEqual(ids);
      for (const [, init] of posts) {
        expect(JSON.parse(String(init.body)).entityType).toBe('article');
        expect(JSON.parse(String(init.body)).entityIds.length).toBeLessThanOrEqual(1000);
      }
    });

    /**
     * Named for the decision, because "clear the parent key" is the obvious simplification
     * and it is the bug this test exists for. `createCachedObject` writes ONE KEY PER ID —
     * `packed:caches:article-stats:<id>` — so a clear of the bare prefix matches nothing.
     *
     * That shipped to production on 2026-09-21. The endpoint answered
     * `{"ok":true,"cleared":0}`, the script logged success, and the feed kept serving the
     * pre-backfill counts: article 14410 read 18/18 against a corrected row of 12/12.
     * Nothing failed — the run had no effect and said it did.
     */
    it('clears the PER-ID cache keys, not the bare prefix', async () => {
      const f = okFetch();

      await propagateArticles([7, 9], f);

      const urls = (f as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => u);
      const clear = urls.find((u) => u.includes('clear-cache-by-pattern'));
      expect(clear).toBeDefined();
      const patterns = decodeURIComponent(clear!);
      expect(patterns).toContain('packed:caches:article-stats:7');
      expect(patterns).toContain('packed:caches:article-stats:9');
    });

    it('THROWS when the clear matched nothing, rather than logging success', async () => {
      // `cleared: 0` is what a wrong key shape looks like, and it is indistinguishable
      // from a successful clear unless the count is read back. It was not, once.
      const f = vi.fn(async (url: string) =>
        String(url).includes('clear-cache-by-pattern')
          ? {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, cleared: 0 }),
              text: async () => '',
            }
          : { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      ) as unknown as typeof fetch;

      await expect(propagateArticles([7], f)).rejects.toThrow('cleared 0 of 1');
    });

    it('accepts a partial clear — the control for the assertion above', async () => {
      // Not every id must match: an article nobody has read recently has no cached entry.
      // Only ALL of them missing means the key shape is wrong.
      const f = vi.fn(async (url: string) =>
        String(url).includes('clear-cache-by-pattern')
          ? {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, cleared: 1 }),
              text: async () => '',
            }
          : { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      ) as unknown as typeof fetch;

      await expect(propagateArticles([7, 9], f)).resolves.toBeUndefined();
    });

    it('does nothing at all for an empty id list', async () => {
      const f = okFetch();

      await propagateArticles([], f);

      expect(f).not.toHaveBeenCalled();
    });

    it('throws on a non-ok response rather than reporting success', async () => {
      const f = vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      })) as unknown as typeof fetch;

      await expect(propagateArticles([1], f)).rejects.toThrow('search-index-update 503');
    });
  });

  describe('the propagation target', () => {
    it('refuses to guess a base URL', () => {
      // Propagation hits PRODUCTION whichever database was written, so a dev rehearsal
      // that propagated would flush the real article cache. No default means it cannot
      // happen unless somebody aimed it.
      vi.stubEnv('WEBHOOK_TOKEN', 'tok');
      // undefined DELETES the variable; '' only blanks it, and an empty string is falsy
      // either way -- so a re-added `?? 'https://civitai.com'` default would slip past.
      vi.stubEnv('INTERNAL_BASE_URL', undefined as unknown as string);

      expect(() => propagationTarget()).toThrow('INTERNAL_BASE_URL must be set explicitly');
    });

    it('requires a token', () => {
      vi.stubEnv('INTERNAL_BASE_URL', 'https://example.test');
      vi.stubEnv('WEBHOOK_TOKEN', undefined as unknown as string);

      expect(() => propagationTarget()).toThrow('WEBHOOK_TOKEN must be set');
    });

    it('returns both when both are set — the control', () => {
      vi.stubEnv('INTERNAL_BASE_URL', 'https://example.test');
      vi.stubEnv('WEBHOOK_TOKEN', 'tok');

      expect(propagationTarget()).toEqual({ base: 'https://example.test', token: 'tok' });
    });

    it('is checked at parse time, not after the table has been written', () => {
      vi.stubEnv('INTERNAL_BASE_URL', undefined as unknown as string);
      vi.stubEnv('WEBHOOK_TOKEN', undefined as unknown as string);

      expect(() => parseArgs(['node', 's.ts', '--write', '--propagate'])).toThrow(
        'INTERNAL_BASE_URL'
      );
    });
  });

  describe('parseArgs', () => {
    beforeEach(() => {
      vi.stubEnv('INTERNAL_BASE_URL', 'https://example.test');
      vi.stubEnv('WEBHOOK_TOKEN', 'tok');
    });

    it('defaults to a dry run with no arguments at all', () => {
      const opts = parseArgs(['node', 'script.ts']);

      expect(opts.write, 'the bare invocation writes to production').toBe(false);
      expect(opts.propagate).toBe(false);
      expect(opts.entities).toEqual(['article', 'bountyEntry']);
      expect(opts.batchSize).toBe(10000);
      expect(opts.start).toBeUndefined();
      expect(opts.end).toBeUndefined();
    });

    it('writes only when --write is given', () => {
      expect(parseArgs(['node', 's.ts', '--write']).write).toBe(true);
    });

    it('refuses to propagate without --write, however it is asked', () => {
      expect(parseArgs(['node', 's.ts', '--propagate']).propagate).toBe(false);
      expect(parseArgs(['node', 's.ts', '--propagate', '--write']).propagate).toBe(true);
    });

    it('reads each named option from its OWN name', () => {
      // Swapping the start/end reads, or misspelling the batch-size key so the default
      // silently wins, are both invisible to a test that only asserts defaults.
      const opts = parseArgs([
        'node',
        's.ts',
        '--start',
        '100',
        '--end',
        '200',
        '--batch-size',
        '25',
      ]);

      expect(opts.start).toBe(100);
      expect(opts.end).toBe(200);
      expect(opts.batchSize).toBe(25);
    });

    it.each(ENTITIES)('selects %s on its own when named', (entity) => {
      expect(parseArgs(['node', 's.ts', '--entity', entity]).entities).toEqual([entity]);
    });

    it('rejects an unknown entity rather than silently running all of them', () => {
      expect(() => parseArgs(['node', 's.ts', '--entity', 'post'])).toThrow('--entity must be one');
    });

    it('rejects a non-numeric bound instead of scanning nothing and reporting success', () => {
      // `--end abc` is NaN, planRanges yields zero batches, and the run prints
      // "0 row(s) would change" — a typo and a clean sweep become the same output.
      expect(() => parseArgs(['node', 's.ts', '--end', 'abc'])).toThrow('--end must be a number');
      expect(() => parseArgs(['node', 's.ts', '--start', 'abc'])).toThrow('--start must be a');
    });

    it('rejects a flag given with no value, which would read as no bound at all', () => {
      // `--end` and `--end 100` differ by one token and by the entire id space.
      expect(() => parseArgs(['node', 's.ts', '--end', '--write'])).toThrow('--end needs a value');
    });

    it('rejects a batch size that cannot terminate the walk', () => {
      // planRanges advances by batchSize; below 1 it is a synchronous loop that never
      // advances — an out-of-memory crash rather than a failure anyone can read.
      expect(() => parseArgs(['node', 's.ts', '--batch-size', '0'])).toThrow('positive integer');
      expect(() => parseArgs(['node', 's.ts', '--batch-size', '-5'])).toThrow('positive integer');
    });

    it('names the database it is pointed at, without leaking the password', () => {
      const described = describeTarget('postgresql://civitai:hunter2@db.example:25061/civitai');

      expect(described).toBe('civitai@db.example:25061/civitai');
      expect(described, 'the password reached a log line').not.toContain('hunter2');
    });

    it('says so rather than guessing when DATABASE_URL is missing or junk', () => {
      expect(describeTarget(undefined)).toBe('DATABASE_URL is not set');
      expect(describeTarget('not-a-url')).toContain('unparseable');
    });
  });

  describe('the timeframe transcription', () => {
    /**
     * Named for the decision. `timeframedReactionSums` is a hand transcription of
     * `snippets.reactionTimeframes()`, copied because importing metric-helpers into a
     * standalone script drags in the Flipt client and the whole metric graph. A copy
     * nothing compares is a fork. If this fails, re-transcribe — do not relax it.
     */
    it('is character-identical to the snippet the bountyEntry job uses', () => {
      expect(normalise(timeframedReactionSums)).toBe(normalise(snippets.reactionTimeframes()));
    });

    it('states each window independently of the snippet', () => {
      // The parity test above catches DRIFT — one side moving. It cannot catch a
      // coordinated edit to both. These literals pin the semantics on their own, so a
      // faithful re-transcription of a changed snippet still has to pass here.
      for (const [timeframe, interval] of [
        ['Year', '365 days'],
        ['Month', '30 days'],
        ['Week', '7 days'],
        ['Day', '1 days'],
      ]) {
        expect(timeframedReactionSums, `the ${timeframe} window is missing`).toContain(
          `tf.timeframe = '${timeframe}' AND r."createdAt" > (NOW() - interval '${interval}')`
        );
      }
      expect(timeframedReactionSums).toContain(`tf.timeframe = 'AllTime' THEN 1`);
      expect(timeframedReactionSums, 'a matching row must score exactly 1').toContain('THEN 1');
      expect(timeframedReactionSums, 'a non-matching row must score 0').toContain('ELSE 0');
    });

    it('scores an outer-joined row as 0 rather than letting it reach the AllTime arm', () => {
      // `IS NOT TRUE`, not `NOT (...)`: under the LEFT JOIN an unmatched row makes the
      // condition NULL, and NULL would fall through and count a reaction that is not there.
      for (const reaction of Object.keys(ReviewReactions)) {
        expect(timeframedReactionSums).toContain(`WHEN (r.reaction = '${reaction}') IS NOT TRUE`);
      }
    });

    it('keeps the AllTime sums identical to the article job they copy', () => {
      // The timeframed half has a parity source; this half had none, so a change to the
      // job's aggregate would have diverged silently.
      const job = readFileSync(
        path.join(process.cwd(), 'src/server/metrics/article.metrics.ts'),
        'utf8'
      );
      const sql = dry('article');

      for (const reaction of Object.keys(ReviewReactions)) {
        const line = `SUM(CASE WHEN r.reaction = '${reaction}' THEN 1 ELSE 0 END)::int AS "${reaction.toLowerCase()}Count"`;
        expect(sql, `${reaction} is not in the script`).toContain(line);
        expect(job, `${reaction} no longer matches article.metrics.ts`).toContain(line);
      }
    });
  });

  describe('the exclusion filter', () => {
    it('filters the REACTOR on both sides, for every entity', () => {
      // Deleting the `NOT IN` from the sums join makes the computed sum equal the stored
      // one, so nothing differs, nothing is written, and the run reports a clean sweep
      // having done nothing. That is the failure this whole script exists to prevent.
      for (const entity of ENTITIES) {
        const table = entity === 'article' ? '"ArticleReaction"' : '"BountyEntryReaction"';
        const sql = dry(entity);
        const references = sql.match(new RegExp(table, 'g')) ?? [];
        const filters = sql.match(/"userId" (?:NOT )?IN \(11,22\)/g) ?? [];

        expect(
          filters.length,
          `${entity}: ${references.length} refs, ${filters.length} filters`
        ).toBe(references.length);
        expect(sql, `${entity} does not exclude the reactors from its sum`).toContain(
          `AND r."userId" NOT IN (${EXCLUDED})`
        );
        expect(sql, `${entity} does not find affected entities by the reactor`).toContain(
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
      expect(dry('bountyEntry')).toContain(`unnest(enum_range(NULL::"MetricTimeframe"))`);
    });

    it('stamps updatedAt on every row it writes', () => {
      expect(write('article')).toContain('"updatedAt" = NOW()');
      expect(write('bountyEntry')).toContain('"updatedAt" = NOW()');
    });

    it('issues a SELECT in dry mode and an UPDATE in write mode, per entity', () => {
      for (const entity of ENTITIES) {
        expect(sqlFor(specs[entity], range, false)).not.toMatch(/UPDATE|RETURNING/);
        expect(sqlFor(specs[entity], range, true)).toMatch(/UPDATE/);
      }
    });
  });

  describe('range planning', () => {
    it('is inclusive at both ends and gapless', () => {
      expect(planRanges(0, 25, 10)).toEqual([
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
    const stubFetch = (impl: () => unknown) => {
      vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test');
      vi.stubEnv('CLICKHOUSE_USERNAME', 'tester');
      const f = vi.fn(async () => impl());
      vi.stubGlobal('fetch', f);
      return f;
    };

    it('asks ClickHouse the same question the app asks', async () => {
      // `active = 1` -> `active = 0` inverts the list into the UN-excluded users and
      // writes wrong totals everywhere, without ever being empty. Dropping FINAL can
      // return a stale part. Neither is visible unless the query text is asserted.
      const f = stubFetch(() => ({ ok: true, json: async () => ({ data: [[11]] }) }));

      await fetchExcludedUserIds();

      expect(f).toHaveBeenCalledTimes(1);
      const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
      expect(init.body).toBe('SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1');
    });

    it('THROWS on an empty list rather than running', async () => {
      // An empty list makes every computed sum equal its stored value, so the run would
      // rewrite nothing and report a clean sweep.
      stubFetch(() => ({ ok: true, json: async () => ({ data: [] }) }));

      await expect(fetchExcludedUserIds()).rejects.toThrow('exclusion list is empty');
    });

    it('returns the ids when the list is populated — the control for the above', async () => {
      stubFetch(() => ({ ok: true, json: async () => ({ data: [[11], [22]] }) }));

      await expect(fetchExcludedUserIds()).resolves.toEqual([11, 22]);
    });

    it('coerces the string ids JSONCompact actually returns for a 64-bit column', async () => {
      stubFetch(() => ({ ok: true, json: async () => ({ data: [['11'], ['22']] }) }));

      await expect(fetchExcludedUserIds()).resolves.toEqual([11, 22]);
    });

    it('THROWS when ClickHouse answers non-ok', async () => {
      stubFetch(() => ({ ok: false, status: 503, text: async () => 'unavailable' }));

      await expect(fetchExcludedUserIds()).rejects.toThrow('clickhouse 503');
    });

    it('drops a null userId rather than suppressing user 0', async () => {
      stubFetch(() => ({ ok: true, json: async () => ({ data: [[11], [null], [22]] }) }));

      await expect(fetchExcludedUserIds()).resolves.toEqual([11, 22]);
    });

    it('is reported by a digest stable under reordering and sensitive to membership', () => {
      expect(digestOf([22, 11])).toBe(digestOf([11, 22]));
      expect(digestOf([11, 23])).not.toBe(digestOf([11, 22]));
    });
  });

  describe('the entrypoint guard', () => {
    it('matches this file, so a rename cannot turn the run into a silent no-op', () => {
      // The guard is a substring test against argv[1]. Rename or move the script and it
      // becomes import-only: it runs, prints nothing, and exits 0 — a success-shaped
      // result for a run that did nothing.
      const source = readFileSync(SCRIPT, 'utf8');
      const basename = path.basename(SCRIPT, '.ts');

      expect(source).toContain(`const SCRIPT_BASENAME = '${basename}'`);
      expect(source).toContain('process.argv[1]?.includes(SCRIPT_BASENAME)');
    });
  });
});
