import { describe, expect, it, vi } from 'vitest';

/**
 * Which UserRestriction row the User Lookup header and its ruling form speak for.
 *
 * 🔴 The panel shows ONE row, and until #4609 it picked "newest of any type" — `ORDER BY ur.id DESC
 * LIMIT 1`, no type predicate. That was sound only while a user could hold at most one open row.
 * Restrictions now dedupe PER TYPE, so two open cases can coexist, and the old ordering had a silent
 * failure mode: a Pending generation case sitting behind a LATER Upheld bot-account row rendered as
 * *no open restriction at all* — the account stays muted, the ruling form is never drawn, and nobody
 * looking at the account can see there is an open case.
 *
 * Asserted against the COMPILED SQL. There is no database in this tier, and the ordering is the whole
 * behaviour — it decides which of several rows the moderator is shown, and it typechecks and lints
 * identically either way. Same instrument the sibling `restriction-type-filter.test.ts` uses, for the
 * same reason.
 */

const captured = vi.hoisted(() => [] as string[]);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports.
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  // One canned row, so `executeTakeFirst` resolves and the chain does not stop early.
  const db = capturingDb(captured, [{ id: 1 }]);
  return { dbRead: db, dbWrite: db };
});

// The identity query is the only thing under test here; its module's other exports reach a second
// database and an HTTP service, and none of them is on this path.
const { getIdentity } = await import('../user-lookup.service');

const identitySql = async (): Promise<string> => {
  captured.length = 0;
  await getIdentity(42);
  // 🔴 Count first. A chain that stopped early would leave `captured` empty while every assertion over
  // its contents passed vacuously.
  expect(captured).toHaveLength(1);
  return captured[0].replace(/\s+/g, ' ');
};

/**
 * The three correlated subqueries that read the account's restriction, sliced from the head of each
 * `FROM "UserRestriction" ur` to its `LIMIT 1`.
 */
const restrictionSubqueries = (sql: string): string[] =>
  sql
    .split('FROM "UserRestriction" ur')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('LIMIT 1');
      expect(end).toBeGreaterThan(-1);
      return chunk.slice(0, end).trim();
    });

describe('user lookup — which restriction the panel speaks for', () => {
  it('reads three restriction columns, which is what the panel needs to render a ruling form', async () => {
    const sql = await identitySql();

    // Positive control on the slicer, and the thing that makes every assertion below non-vacuous: a
    // rename or a fourth column shows up here rather than silently reducing the loops to no-ops.
    expect(restrictionSubqueries(sql)).toHaveLength(3);
    for (const alias of ['restrictionStatus', 'restrictionType', 'restrictionId'])
      expect(sql).toContain(`as "${alias}"`);
  });

  /**
   * 🔴 The regression. A Pending row outranks a merely newer one, so an open case cannot be hidden
   * behind a later resolved one of another type.
   */
  it('prefers a Pending row over a newer one, in every restriction column', async () => {
    const sql = await identitySql();

    for (const sub of restrictionSubqueries(sql))
      expect(sub).toContain(`ORDER BY (ur.status = 'Pending') DESC NULLS LAST, ur.id DESC`);
  });

  /**
   * 🔴 The null placement, asserted on its own so it cannot be dropped by someone tidying the
   * ordering above back to a bare `DESC`.
   *
   * Postgres defaults `DESC` to `NULLS FIRST`. A NULL `(ur.status = 'Pending')` would therefore sort
   * ABOVE a genuinely Pending row and hide the open case — exactly the failure the preference exists
   * to prevent, arriving through the column's nullability rather than through the ordering. The
   * column is a NOT NULL enum today, so this is an unstated precondition being made explicit rather
   * than a live defect; spelled out, the ordering no longer depends on it.
   */
  it('places nulls last, so the ordering does not depend on status being NOT NULL', async () => {
    const sql = await identitySql();
    const subs = restrictionSubqueries(sql);

    // Non-vacuous: three subqueries exist to check. (The slicer's own control lives in the first
    // test; this repeats the count because an empty list would make the loop below pass.)
    expect(subs).toHaveLength(3);
    for (const sub of subs) {
      expect(sub).toContain(`'Pending') DESC NULLS LAST`);
      // And not a bare `DESC` on that expression, which is what the default null placement is.
      expect(sub).not.toMatch(/'Pending'\)\s+DESC\s*,/);
    }
  });

  /**
   * The tiebreak has to be TOTAL, or the three subqueries are free to resolve to different rows and
   * the panel renders one row's status against another's id — a ruling form posting an id that does
   * not belong to the case it is describing.
   */
  it('breaks the tie on a unique column, so the three columns name one row', async () => {
    const sql = await identitySql();
    const subs = restrictionSubqueries(sql);

    for (const sub of subs) expect(sub).toContain('ur.id DESC');
    // Identical apart from the column each selects — which is the only reason they agree. (An
    // INVARIANT GUARD: true before this change too. Kept because the fix replaced three hand-written
    // copies with one helper, and this is what stops them being hand-written again.)
    const withoutSelectList = subs.map((s) => s.slice(s.indexOf('WHERE')));
    expect(new Set(withoutSelectList).size).toBe(1);
  });

  it('scopes each subquery to the account being looked up', async () => {
    const sql = await identitySql();

    for (const sub of restrictionSubqueries(sql)) expect(sub).toContain(`ur."userId" = u.id`);
  });
});
