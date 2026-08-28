import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The monorepo root, found by walking up for the workspace manifest rather than counting `../`
 * segments. A fixed depth silently changes meaning the moment this file moves, and the failure
 * would be an unreadable ENOENT rather than "the guard moved".
 */
const repoRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('ingestion-queue-partition.test: could not locate the workspace root');
})();

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
const captured = vi.hoisted(
  () => [] as { sql: string; parameters: readonly unknown[]; client: 'read' | 'write' }[]
);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports,
// so constructing Kysely there reads it before initialisation.
/**
 * 🔴 `dbRead` and `dbWrite` are DISTINCT instances that tag what they compiled.
 *
 * Aliasing them to one object — which this harness used to do — makes them indistinguishable by
 * construction, so nothing can pin WHICH client a query runs on. That matters because
 * `imageRowExists` is a read-your-write: on the replica, lag past the delete's own round trip makes
 * a successful delete read as "still present", producing a false failure and no audit row for a
 * delete that did happen. A single shared instance cannot see that regression.
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

const {
  getIngestionErrorImages,
  countIngestionErrorImages,
  getMissingMediaImages,
  countMissingMediaImages,
  isMissingMediaImage,
  imageRowExists,
} = await import('../ingestion.service');

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

/** The predicate only: everything between WHERE and ORDER BY (or the end, for the count queries). */
function whereClause(sql: string) {
  const at = sql.indexOf(' WHERE ');
  expect(at, 'statement has a WHERE clause').toBeGreaterThan(-1);
  const rest = sql.slice(at + ' WHERE '.length);
  const order = rest.indexOf(' ORDER BY ');
  return order === -1 ? rest : rest.slice(0, order);
}

describe('ingestion-error queue predicates', () => {
  it('splits the window on publishability, not on the scanner reason text', async () => {
    const errors = await run(() => countIngestionErrorImages());
    const missing = await run(() => countMissingMediaImages());

    // Pinned WHOLE, not by keyword. A guard on a word is walkable by rewording; a guard on the
    // whole normalised statement is not, and a deliberate predicate change has to come here.
    expect(errors.sql).toBe(
      'SELECT count(*) AS count FROM "Image" i WHERE i."createdAt" > now() - INTERVAL \'2 days\' ' +
        'AND i."createdAt" < now() - INTERVAL \'1 hour\' ' +
        'AND i.ingestion = \'Error\'::"ImageIngestionStatus" AND i."nsfwLevel" = 0 ' +
        "AND NOT ( i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 " +
        "OR COALESCE(i.url, '') LIKE $2 )"
    );
    expect(missing.sql).toBe(
      'SELECT count(*) AS count FROM "Image" i WHERE i."createdAt" > now() - INTERVAL \'2 days\' ' +
        'AND i."createdAt" < now() - INTERVAL \'1 hour\' ' +
        'AND i.ingestion = \'Error\'::"ImageIngestionStatus" AND i."nsfwLevel" = 0 ' +
        "AND ( i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 " +
        "OR COALESCE(i.url, '') LIKE $2 )"
    );

    // Both halves are BOUND PARAMETERS carrying the exact stored values, and the second is built
    // from `@civitai/shared`'s `UNRENDERABLE_MEDIA_URL_PREFIX` — the SAME constant the write-side
    // refusal is built from — so the queue cannot select a different set from the one the guard
    // refuses. Divergence there has no symptom on this page and a severe one for the moderator: a
    // row refused on the rating queue and missing from the delete queue has no action left at all.
    expect(errors.parameters).toEqual(['permanent', 'blob:%']);
    expect(missing.parameters).toEqual(['permanent', 'blob:%']);
  });

  it('keeps Image.url NOT NULL, which is what actually makes the url half a partition', () => {
    /**
     * 🔴 THE REAL INVARIANT, PINNED AT ITS SOURCE — and it is NOT the COALESCE below.
     *
     * The story this suite used to tell was that `COALESCE(i.url, '')` was load-bearing against a
     * NULL url. It is not: `Image.url` is NOT NULL, so the row it defends against cannot exist and
     * removing the COALESCE changes no result. What keeps the url half of the split a partition is
     * the column constraint, so the constraint is what gets a guard.
     *
     * Read from BOTH the defining schema and the generated Kysely types, which fail differently: a
     * hand-edit to one without regenerating the other is caught, and so is a regeneration that
     * drops the guard's own subject. `url String?` in Prisma / `url: string | null` in Kysely are
     * the two spellings that would make this queue silently non-exhaustive.
     */
    const prisma = readFileSync(
      path.join(repoRoot, 'packages/civitai-db-schema/prisma/schema.full.prisma'),
      'utf8'
    );
    const imageModel = /\nmodel Image \{\n([\s\S]*?)\n\}/.exec(prisma)?.[1];
    // Positive control on the extraction: a regex that stopped matching would make every assertion
    // below vacuous, and `?.[1]` would hand `undefined` to a `toMatch` that never runs.
    expect(imageModel, 'the Image model must be locatable in schema.full.prisma').toBeTruthy();
    expect(imageModel).toMatch(/^\s{2}url\s+String\s*$/m);
    expect(imageModel, 'Image.url must not become nullable').not.toMatch(/^\s{2}url\s+String\?/m);

    const kysely = readFileSync(
      path.join(repoRoot, 'packages/civitai-db-schema/src/kysely/types.ts'),
      'utf8'
    );
    const imageType = /\nexport type Image = \{\n([\s\S]*?)\n\};/.exec(kysely)?.[1];
    expect(
      imageType,
      'the Image table type must be locatable in the generated kysely types'
    ).toBeTruthy();
    expect(imageType).toMatch(/^\s{2}url: string;$/m);
  });

  it('still COALESCEs the url, as defence in depth if that constraint ever goes', async () => {
    /**
     * 🔴 AN INVARIANT GUARD, NOT A REGRESSION TEST — labelled as one because the previous version
     * of this case was presented as the reason the split stays a partition, and it is not (see the
     * case above). The bug it describes has never been reachable.
     *
     * What it pins is a spelling, deliberately: were `Image.url` ever made nullable, `NULL LIKE
     * 'blob:%'` is NULL, so on a row with a non-permanent class the disjunction is NULL — which a
     * WHERE treats as false on BOTH sides, dropping the row out of the review queue and the
     * missing-media queue simultaneously. Silent, and invisible in the emitted SQL unless you look
     * for the COALESCE. Cheap to keep; do not re-promote it to load-bearing.
     */
    const errors = await run(() => countIngestionErrorImages());
    expect(errors.sql).toContain("COALESCE(i.url, '') LIKE");
    // The bare form, which is what a "simplification" would produce.
    expect(errors.sql).not.toMatch(/\bi\.url LIKE/);
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
      expect(s).not.toMatch(/reason/i);
      // 🔴 There IS a `LIKE` in these statements now — the url-shape disjunct — so a blanket
      // `not.toMatch(/like/i)` is no longer available and would have to be deleted. Deleting it is
      // the wrong move: what it was protecting is that no pattern match is ever aimed at the
      // scanner's PROSE. So the assertion narrows rather than disappears — every `LIKE` in the
      // statement must be the url one, against a bound parameter, and `ILIKE` (the spelling a
      // case-insensitive prose match reaches for) must not appear at all.
      expect(s).not.toMatch(/ILIKE/i);
      // Exactly one, and it is the url one against a bound parameter. A second `LIKE` appearing —
      // which is what a prose match would be — fails on the count before anything else.
      expect([...s.matchAll(/\bLIKE\b/gi)]).toHaveLength(1);
      expect(s).toContain("COALESCE(i.url, '') LIKE $2");
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
    // one side only breaks this, whichever side is edited. Derived from `errors` — where the split
    // predicate is unambiguously delimited by ` AND NOT ` — so adding a disjunct to the split cannot
    // silently move where this test thinks the shared base ends.
    const marker = ' AND NOT ';
    const at = errors.indexOf(marker);
    expect(at, 'the review queue negates the split predicate').toBeGreaterThan(-1);
    const base = errors.slice(0, at);
    const splitPredicate = errors.slice(at + marker.length);
    expect(base.length).toBeGreaterThan(0);
    expect(splitPredicate.length).toBeGreaterThan(0);
    // Exhaustive and exclusive in one line: `missing` must be the same base plus exactly the
    // predicate `errors` negates — no extra clause on either side, no clause missing from either.
    expect(missing).toBe(`${base} AND ${splitPredicate}`);

    /**
     * 🔴 THE SPLIT PREDICATE MUST BE PARENTHESISED, AND THIS IS THE ONLY PLACE THAT SAYS SO.
     *
     * Dropping the parens around `unpublishableMedia` is a one-character edit whose effect is
     * enormous: `NOT (a OR b)` becomes `(NOT a) OR b`, i.e. the review queue would take EVERY
     * `blob:` row — at any age within the window and whatever its scan class — instead of routing
     * it to the delete-only view, which is exactly the harm this branch exists to remove.
     *
     * Measured before this assertion existed: that mutant SURVIVED a run narrowed to this test and
     * died only on the whole-statement pins above — the same pins whose own comments invite an
     * author to rewrite them on a deliberate predicate change. A structural test that cannot see a
     * precedence bug is not covering the structure.
     *
     * `AND` binds tighter than `OR` in SQL, so the requirement is precise: the negated predicate
     * must be a single parenthesised group, and the disjunction must live INSIDE it. Asserted on
     * shape rather than on the exact statement so it survives an edit to the disjuncts themselves.
     */
    expect(
      splitPredicate.startsWith('('),
      `split predicate must open a group: ${splitPredicate}`
    ).toBe(true);
    expect(
      splitPredicate.endsWith(')'),
      `split predicate must close a group: ${splitPredicate}`
    ).toBe(true);
    // ...and the group is the WHOLE predicate, not the first of several. Walking the depth rather
    // than trusting the two ends catches `(a OR b) OR c`, where both ends are still parens.
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
    // The OR is inside that group. Without the parens it would sit at the top level of the WHERE,
    // which is the mutant.
    expect(splitPredicate).toMatch(/\bOR\b/);
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
    expect(sql).toContain('AND (i.id < $3)');
    expect(parameters).toEqual(['permanent', 'blob:%', 999, 26]);
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
  it('scopes the delete to an unpublishable, unpublished ingestion error', async () => {
    const { sql, parameters } = await run(() => isMissingMediaImage(4242));

    expect(sql).toBe(
      'SELECT i.id FROM "Image" i WHERE i.ingestion = \'Error\'::"ImageIngestionStatus" ' +
        'AND i."nsfwLevel" = 0 ' +
        "AND ( i.\"scanJobs\"->'error'->>'failureClass' IS NOT DISTINCT FROM $1 " +
        "OR COALESCE(i.url, '') LIKE $2 ) " +
        'AND i.id = $3 LIMIT 1'
    );
    expect(parameters).toEqual(['permanent', 'blob:%', 4242]);
  });

  it('is always bound to the requested id — never an unscoped match', async () => {
    // The specific mutant: dropping the state predicates, or the id, makes this a delete-anything
    // endpoint. Asserted separately from the pin above so it stays reachable if the pin is edited.
    const { sql } = await run(() => isMissingMediaImage(4242));
    expect(sql).toContain('AND i.id = $3');
    expect(sql).not.toMatch(/WHERE\s+TRUE/i);
  });

  it('accepts a row refused for its URL SHAPE, not only one with a permanent scan failure', async () => {
    /**
     * 🔴 THE FINDING THIS CLOSES. The publish guard refuses two verdicts — `absent` and
     * `unrenderable` — and this gate used to admit only the first. A `blob:` row whose scan failure
     * was transient, or unclassified (a NULL `failureClass`, which `ingestionErrorWhere`
     * deliberately routes to the rateable queue), was therefore refused on the rating queue AND
     * refused by the only delete this app offers: a refusal with no reachable action, i.e. a
     * permanently stuck row. The message the guard shows says "Delete it"; this clause is what makes
     * that sentence true.
     *
     * Asserted on the DISJUNCTION rather than by re-pinning the statement, so it stays reachable
     * when the whole-statement pin above is edited.
     */
    const { sql } = await run(() => isMissingMediaImage(4242));
    expect(sql).toContain("COALESCE(i.url, '') LIKE $2");
    // ...and as a disjunct, never an extra requirement — an `AND` here would refuse every row that
    // is missing from storage but has an ordinary key, which is the bulk of this queue.
    expect(sql).toMatch(/IS NOT DISTINCT FROM \$1 OR COALESCE/);
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

  it('shares EVERY state predicate with the queue, so the two cannot disagree', async () => {
    /**
     * 🔴 Asserted over the whole clause SET, not one clause of three, and in BOTH directions.
     *
     * The first version named the relationship in its title and checked only `failureClass`:
     * changing the queue's `nsfwLevel = 0` bound left the gate behind and the test stayed green.
     * The second widened that to every gate clause — but only as `gate ⊆ queue`, which is blind in
     * the direction that actually widens a permanent cascading delete: the QUEUE gaining a clause
     * the gate lacks. (Measured: adding a clause to `missingMediaWhere` alone was killed by the
     * queue's own whole-statement pins, not by this test — so the title was not true of the code.)
     *
     * Equality of the two sets is what the title claims, so equality is what is asserted. The two
     * differences that are DELIBERATE are subtracted by name: the gate's id binding, and the queue's
     * display window (see the case above for why the gate must not carry it).
     */
    const gate = (await run(() => isMissingMediaImage(4242))).sql;
    const queue = (await run(() => countMissingMediaImages())).sql;

    const clauses = (statement: string) =>
      statement
        .slice(statement.indexOf(' WHERE ') + ' WHERE '.length)
        .replace(/ LIMIT \d+$/, '')
        .split(/\bAND\b/)
        .map((c) =>
          c
            .trim()
            .replace(/^\(+|\)+$/g, '')
            .trim()
        )
        .filter(Boolean);

    const gateState = clauses(gate).filter((c) => !c.startsWith('i.id ='));
    const queueState = clauses(queue).filter((c) => !c.startsWith('i."createdAt"'));

    // Positive control on the splitter: if it stopped decomposing, both sides would be one opaque
    // string and the equality below would pass vacuously.
    expect(gateState.length).toBeGreaterThanOrEqual(3);
    expect(queueState.length).toBeGreaterThanOrEqual(3);
    // 🔴 BOTH subtractions are counted, not just the queue's. Checking only one side leaves the
    // other filter free to drop an arbitrary number of clauses and still reach equality — e.g. a
    // gate clause that happened to start `i.id =` would vanish silently. The two deliberate
    // differences are exactly: two window bounds on the queue side, one id binding on the gate side.
    expect(
      clauses(queue).length - queueState.length,
      'the queue drops exactly its two window bounds'
    ).toBe(2);
    expect(clauses(gate).length - gateState.length, 'the gate drops exactly its id binding').toBe(
      1
    );

    // 🔴 Bidirectional. `toEqual` on sorted arrays fails when either side gains OR loses a clause.
    expect([...gateState].sort()).toEqual([...queueState].sort());
  });
});

describe('read-your-write: the delete confirmation must not read a replica', () => {
  /**
   * 🔴 `imageRowExists` runs milliseconds after a delete on the primary, to decide whether that
   * delete happened. On `dbRead` — a separate pool on the replica connection string — any lag past
   * that round trip makes a SUCCESSFUL delete read as "still present": a false failure, and no audit
   * row for a delete that did happen. The exact mirror of the bug the read-back prevents.
   *
   * Nothing pinned this before, so a one-word revert to `dbRead` would have been invisible.
   */
  it('confirms the delete against the PRIMARY, not the replica', async () => {
    const { client, sql, parameters } = await run(() => imageRowExists(4242));
    expect(client).toBe('write');
    expect(sql).toBe('SELECT i.id FROM "Image" i WHERE i.id = $1 LIMIT 1');
    expect(parameters).toEqual([4242]);
  });

  it('still reads the replica for the queues and badges, which are not read-your-write', async () => {
    // The flip side: these are ordinary list reads and must NOT be moved onto the primary.
    expect((await run(() => countMissingMediaImages())).client).toBe('read');
    expect((await run(() => getMissingMediaImages({ limit: 10 }))).client).toBe('read');
    expect((await run(() => countIngestionErrorImages())).client).toBe('read');
  });
});
