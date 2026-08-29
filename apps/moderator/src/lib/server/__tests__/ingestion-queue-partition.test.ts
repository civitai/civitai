import { describe, expect, it, vi } from 'vitest';

/**
 * The ingestion-error page's SQL, compiled for real.
 *
 * The queue and its badge are built from shared `sql` fragments, and the property that matters is a
 * relationship BETWEEN the two statements, not the content of either: they must carry the same
 * predicate, or the badge never reaches zero on a drained page. A hand-rolled fake cannot see that
 * — only the emitted SQL can. So `dbRead` here is real Kysely on a driver that never connects, and
 * every assertion reads the statement it produced.
 */
const captured = vi.hoisted(
  () => [] as { sql: string; parameters: readonly unknown[]; client: 'read' | 'write' }[]
);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports,
// so constructing Kysely there reads it before initialisation.
/**
 * 🔴 `dbRead` and `dbWrite` are DISTINCT instances that tag what they compiled, so a query moving
 * between the replica and the primary is visible. Aliasing them to one object would make them
 * indistinguishable by construction, and nothing could then pin WHICH client a query runs on.
 */
vi.mock('$lib/server/db', async () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import('kysely');
  const make = (client: 'read' | 'write') =>
    new Kysely<never>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (i) => new PostgresIntrospector(i),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: (e) => {
        if (e.level === 'query')
          captured.push({ sql: e.query.sql, parameters: e.query.parameters, client });
      },
    });
  return { dbRead: make('read'), dbWrite: make('write') };
});

const { getIngestionErrorImages, countIngestionErrorImages } = await import('../ingestion.service');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

async function run(fn: () => Promise<unknown>) {
  captured.length = 0;
  await fn();
  // A positive control on the harness itself: a query that never compiled would leave this empty,
  // and every assertion below would then be reading a stale or absent statement.
  expect(captured.length, 'the query under test must have compiled').toBe(1);
  return {
    sql: norm(captured[0].sql),
    parameters: captured[0].parameters,
    client: captured[0].client,
  };
}

/** The predicate only: everything between WHERE and ORDER BY (or the end, for the count query). */
function whereClause(sql: string) {
  const at = sql.indexOf(' WHERE ');
  expect(at, 'statement has a WHERE clause').toBeGreaterThan(-1);
  const rest = sql.slice(at + ' WHERE '.length);
  const order = rest.indexOf(' ORDER BY ');
  return order === -1 ? rest : rest.slice(0, order);
}

describe('ingestion-error queue predicate', () => {
  it('carves out permanent scan failures, keyed on the stored CLASS not the reason text', async () => {
    const errors = await run(() => countIngestionErrorImages());

    // Pinned WHOLE, not by keyword. A guard on a word is walkable by rewording; a guard on the
    // whole normalised statement is not, and a deliberate predicate change has to come here.
    expect(errors.sql).toBe(
      'SELECT count(*) AS count FROM "Image" i WHERE i."createdAt" > now() - INTERVAL \'2 days\' ' +
        'AND i."createdAt" < now() - INTERVAL \'1 hour\' ' +
        'AND i.ingestion = \'Error\'::"ImageIngestionStatus" AND i."nsfwLevel" = 0 ' +
        "AND NOT ( i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 )"
    );

    // The class is a BOUND PARAMETER carrying the exact string the main app stores. Both sides read
    // it from `@civitai/shared`, so a rename cannot leave one behind.
    expect(errors.parameters).toEqual(['permanent']);
  });

  it('never keys the split off the scanner reason TEXT', async () => {
    // Its own case, deliberately, so it stays REACHABLE. Folded into the pin above it would be
    // unreachable the moment the pin fails, and a mutant that swapped the class predicate for
    // `reason ILIKE '%download%'` would then die to the pin rather than to the rule it violates.
    // The reason string is prose the scanner owns: one reword and every permanently-broken image
    // walks back into the review queue, silently.
    const errors = await run(() => countIngestionErrorImages());
    expect(errors.sql).not.toMatch(/reason/i);
    // No pattern match of any kind is aimed at that prose. `ILIKE` is the spelling a
    // case-insensitive prose match reaches for; `LIKE` covers the case-sensitive one.
    expect(errors.sql).not.toMatch(/\bI?LIKE\b/i);
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

  it('NEGATES A PARENTHESISED GROUP, so a second disjunct cannot silently invert the split', async () => {
    /**
     * 🔴 THIS IS THE ONLY PLACE THAT SAYS SO, and the mutant it kills is a one-character edit.
     *
     * With one conjunct today, `NOT a` and `NOT ( a )` are the same query, so nothing else in this
     * file can see the difference. The moment a second predicate is added inside — which is the
     * expected way this grows — the missing parens turn `NOT (a OR b)` into `(NOT a) OR b`, i.e.
     * the review queue would take EVERY row matching the new predicate instead of carving it out.
     * `AND` binds tighter than `OR` in SQL, so the requirement is precise: the negated predicate
     * must be a single parenthesised group spanning the whole thing.
     *
     * Asserted on SHAPE rather than on the exact statement, so it survives an edit to the disjuncts
     * themselves — and so it keeps failing for its own reason rather than dying to the pin above.
     */
    const errors = whereClause((await run(() => countIngestionErrorImages())).sql);

    const marker = ' AND NOT ';
    const at = errors.indexOf(marker);
    expect(at, 'the review queue negates the split predicate').toBeGreaterThan(-1);
    const splitPredicate = errors.slice(at + marker.length);
    expect(splitPredicate.length).toBeGreaterThan(0);

    expect(
      splitPredicate.startsWith('('),
      `split predicate must open a group: ${splitPredicate}`
    ).toBe(true);
    expect(
      splitPredicate.endsWith(')'),
      `split predicate must close a group: ${splitPredicate}`
    ).toBe(true);
    // ...and the group is the WHOLE predicate, not the first of several. Walking the depth rather
    // than trusting the two ends catches `(a) OR c`, where both ends are still parens.
    let depth = 0;
    let closedEarly = false;
    for (let i = 0; i < splitPredicate.length; i++) {
      if (splitPredicate[i] === '(') depth++;
      else if (splitPredicate[i] === ')') {
        depth--;
        if (depth === 0 && i < splitPredicate.length - 1) closedEarly = true;
      }
    }
    expect(depth, 'parentheses in the split predicate must balance').toBe(0);
    expect(closedEarly, `the negated group must span the WHOLE predicate: ${splitPredicate}`).toBe(
      false
    );
  });

  it('keeps the window and state bounds OUTSIDE the negation', async () => {
    /**
     * The other half of the precedence property, and it fails on a different mutant: moving a window
     * bound inside the negated group inverts it (rows OLDER than 2 days would be listed), which the
     * shape walk above cannot see because the parens would still balance.
     *
     * Derived structurally from where the negation starts, so it does not restate the pin.
     */
    const errors = whereClause((await run(() => countIngestionErrorImages())).sql);
    const at = errors.indexOf(' AND NOT ');
    // Fail on the missing marker rather than letting `slice(0, -1)` silently lop a character off
    // the base and report a confusing mismatch on some unrelated clause.
    expect(at, 'the review queue negates the split predicate').toBeGreaterThan(-1);
    const base = errors.slice(0, at);

    expect(base).toContain('i."createdAt" > now() - INTERVAL \'2 days\'');
    expect(base).toContain('i."createdAt" < now() - INTERVAL \'1 hour\'');
    expect(base).toContain('i.ingestion = \'Error\'::"ImageIngestionStatus"');
    expect(base).toContain('i."nsfwLevel" = 0');
    // ...and none of them leaked into the negated half.
    const negated = errors.slice(at);
    expect(negated).not.toContain('createdAt');
    expect(negated).not.toContain('nsfwLevel');
    expect(negated).not.toContain('ingestion');
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

  it('pages by cursor, carrying the class parameter ahead of it', async () => {
    const { sql, parameters } = await run(() =>
      getIngestionErrorImages({ limit: 25, cursor: 999 })
    );
    expect(sql).toContain('AND (i.id < $2)');
    expect(parameters).toEqual(['permanent', 999, 26]);
  });

  it('reads the replica for the queue and its badge, which are not read-your-write', async () => {
    expect((await run(() => countIngestionErrorImages())).client).toBe('read');
    expect((await run(() => getIngestionErrorImages({ limit: 10 }))).client).toBe('read');
  });
});
