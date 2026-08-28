import { describe, expect, it, vi } from 'vitest';

/**
 * The ingestion-error page's SQL, compiled for real.
 *
 * These four queries are built from two shared `sql` fragments, and the property that matters is a
 * relationship BETWEEN them, not the content of any one: the list and its badge must carry the same
 * predicate (or the count never reaches zero on a drained page), and the review queue and the
 * missing-media view must partition the same window rather than overlap or leave a gap.
 *
 * A hand-rolled fake cannot see any of that — only the emitted SQL can. So `dbRead` here is real
 * Kysely on a driver that never connects, and every assertion reads the statement it produced.
 */
const captured = vi.hoisted(() => [] as { sql: string; parameters: readonly unknown[] }[]);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports,
// so constructing Kysely there reads it before initialisation.
vi.mock('$lib/server/db', async () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import('kysely');
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (i) => new PostgresIntrospector(i),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (e) => {
      if (e.level === 'query') captured.push({ sql: e.query.sql, parameters: e.query.parameters });
    },
  });
  return { dbRead: db, dbWrite: db };
});

const {
  getIngestionErrorImages,
  countIngestionErrorImages,
  getMissingMediaImages,
  countMissingMediaImages,
  isMissingMediaImage,
} = await import('../ingestion.service');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

async function run(fn: () => Promise<unknown>) {
  captured.length = 0;
  await fn();
  // A positive control on the harness itself: a query that never compiled would leave this empty,
  // and every assertion below would then be reading a stale or absent statement.
  expect(captured.length, 'the query under test must have compiled').toBe(1);
  return { sql: norm(captured[0].sql), parameters: captured[0].parameters };
}

/** The predicate only: everything between WHERE and ORDER BY (or the end, for the count queries). */
function whereClause(sql: string) {
  const at = sql.indexOf(' WHERE ');
  expect(at, 'statement has a WHERE clause').toBeGreaterThan(-1);
  const rest = sql.slice(at + ' WHERE '.length);
  const order = rest.indexOf(' ORDER BY ');
  return order === -1 ? rest : rest.slice(0, order);
}

describe('ingestion-error queue predicates', () => {
  it('splits the window on the stored failure class, not on the scanner reason text', async () => {
    const errors = await run(() => countIngestionErrorImages());
    const missing = await run(() => countMissingMediaImages());

    // Pinned WHOLE, not by keyword. A guard on a word is walkable by rewording; a guard on the
    // whole normalised statement is not, and a deliberate predicate change has to come here.
    expect(errors.sql).toBe(
      'SELECT count(*) AS count FROM "Image" i WHERE i."createdAt" > now() - INTERVAL \'2 days\' ' +
        'AND i."createdAt" < now() - INTERVAL \'1 hour\' ' +
        'AND i.ingestion = \'Error\'::"ImageIngestionStatus" AND i."nsfwLevel" = 0 ' +
        "AND NOT ( i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 )"
    );
    expect(missing.sql).toBe(
      'SELECT count(*) AS count FROM "Image" i WHERE i."createdAt" > now() - INTERVAL \'2 days\' ' +
        'AND i."createdAt" < now() - INTERVAL \'1 hour\' ' +
        'AND i.ingestion = \'Error\'::"ImageIngestionStatus" AND i."nsfwLevel" = 0 ' +
        "AND i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1"
    );

    // The class is a BOUND PARAMETER carrying the exact stored value.
    expect(errors.parameters).toEqual(['permanent']);
    expect(missing.parameters).toEqual(['permanent']);
  });

  it('never keys the split off the scanner reason TEXT', async () => {
    // Its own case, deliberately, so it stays REACHABLE. Folded into the pin above it would be
    // unreachable the moment the pin fails, and a mutant that swapped the class predicate for
    // `reason ILIKE '%download%'` would then die to the pin rather than to the rule it violates.
    // The reason string is prose the scanner owns: one reword and every permanently-broken image
    // walks back into the review queue, silently.
    const errors = await run(() => countIngestionErrorImages());
    const missing = await run(() => countMissingMediaImages());
    for (const s of [errors.sql, missing.sql]) {
      expect(s).not.toMatch(/like/i);
      expect(s).not.toMatch(/reason/i);
    }
  });

  it('is NULL-safe, so an unclassified failure still reaches a human', async () => {
    // The false-positive guard, and the one that matters more than the true positive. The JSON path
    // yields NULL for an image with no stored scan error, and `NULL <> 'permanent'` is NULL — which
    // a WHERE treats as false. A plain `<>` would therefore drop every unclassified failure out of
    // the review queue, i.e. the ordinary timeouts and container churn that are the bulk of it.
    const errors = await run(() => countIngestionErrorImages());
    expect(errors.sql).toContain('IS NOT DISTINCT FROM');
    expect(errors.sql).not.toMatch(/failureClass'\s*<>/);
    expect(errors.sql).not.toMatch(/failureClass'\s*!=/);
  });

  it('partitions the same window: the two views share every other predicate', async () => {
    const errors = whereClause((await run(() => countIngestionErrorImages())).sql);
    const missing = whereClause((await run(() => countMissingMediaImages())).sql);

    // Structural, not textual: the missing-media predicate is the error predicate with the negation
    // removed. Widening the window, changing the ingestion state, or moving the nsfwLevel bound on
    // one side only breaks this, whichever side is edited.
    const base = missing.slice(0, missing.indexOf('AND i."scanJobs"'));
    expect(base.length).toBeGreaterThan(0);
    expect(errors.startsWith(base)).toBe(true);
    // `missing` adds `AND <class predicate>`; `errors` must add exactly its negation.
    const classPredicate = missing.slice(base.length).replace(/^AND /, '');
    expect(errors.slice(base.length)).toBe(`AND NOT ( ${classPredicate} )`);
  });

  it('gives the ingestion-error badge the same predicate as its queue', async () => {
    // The property the service comments call out: a divergence here is a count that never reaches
    // zero. Written so that FORKING the const — giving the count its own copy of the predicate and
    // then editing either one — fails, rather than only a wholesale rewrite.
    const list = whereClause((await run(() => getIngestionErrorImages({ limit: 50 }))).sql);
    const count = whereClause((await run(() => countIngestionErrorImages())).sql);
    expect(list.startsWith(count)).toBe(true);
    // The only thing the list adds is its cursor clause.
    expect(list.slice(count.length).trim()).toBe('AND (TRUE)');
  });

  it('gives the missing-media badge the same predicate as its queue', async () => {
    const list = whereClause((await run(() => getMissingMediaImages({ limit: 50 }))).sql);
    const count = whereClause((await run(() => countMissingMediaImages())).sql);
    expect(list.startsWith(count)).toBe(true);
    expect(list.slice(count.length).trim()).toBe('AND (TRUE)');
  });

  it('pages the missing-media view by cursor, like the queue it was split from', async () => {
    const { sql, parameters } = await run(() => getMissingMediaImages({ limit: 25, cursor: 999 }));
    expect(sql).toContain('AND (i.id < $2)');
    expect(parameters).toEqual(['permanent', 999, 26]);
  });
});

describe("the delete gate's own predicate", () => {
  /**
   * 🔴 This query gates a PERMANENT, CASCADING delete, and it was the one query in this module the
   * harness did not compile. A mutation sweep found `WHERE ${missingMediaScope}` could be replaced
   * with `WHERE TRUE` — restoring the arbitrary delete-any-image-by-id endpoint the guard exists to
   * prevent — with the whole suite still green, because its only test mocked the function wholesale
   * and therefore pinned the call site rather than the predicate.
   */
  it('scopes the delete to a permanently-failed, unpublished ingestion error', async () => {
    const { sql, parameters } = await run(() => isMissingMediaImage(4242));

    expect(sql).toBe(
      'SELECT i.id FROM "Image" i WHERE i.ingestion = \'Error\'::"ImageIngestionStatus" ' +
        'AND i."nsfwLevel" = 0 ' +
        "AND i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 " +
        'AND i.id = $2 LIMIT 1'
    );
    expect(parameters).toEqual(['permanent', 4242]);
  });

  it('is always bound to the requested id — never an unscoped match', async () => {
    // The specific mutant: dropping the state predicates, or the id, makes this a delete-anything
    // endpoint. Asserted separately from the pin above so it stays reachable if the pin is edited.
    const { sql } = await run(() => isMissingMediaImage(4242));
    expect(sql).toContain('AND i.id = $2');
    expect(sql).not.toMatch(/WHERE\s+TRUE/i);
  });

  it('deliberately omits the 2-day display window the queue applies', async () => {
    /**
     * Safety is about the image's STATE, which does not expire; the window is a display concern.
     * Conflating them made the gate a race: a row ageing out between page load and click was
     * refused for an image visibly on screen, and was then permanently uncleanable — it had left
     * the only view offering a delete while still sitting at `ingestion = 'Error'`.
     */
    const gate = (await run(() => isMissingMediaImage(4242))).sql;
    expect(gate).not.toContain('createdAt');

    // ...while the queue itself still applies it, or the page would grow without bound.
    const queue = (await run(() => countMissingMediaImages())).sql;
    expect(queue).toContain('i."createdAt" > now() - INTERVAL \'2 days\'');
  });

  it('shares the failure-class predicate with the queue, so the two cannot disagree', async () => {
    const gate = (await run(() => isMissingMediaImage(4242))).sql;
    const queue = (await run(() => countMissingMediaImages())).sql;
    const clause = "i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1";
    expect(gate).toContain(clause);
    expect(queue).toContain(clause);
  });
});
