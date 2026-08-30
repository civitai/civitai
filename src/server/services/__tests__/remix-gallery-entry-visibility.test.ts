import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { getRemixGalleryCardSummaries } from '~/server/services/remix-gallery.service';

/**
 * The gates on a remix-gallery entry, pinned because production data cannot pin
 * them.
 *
 * Four of the predicates asserted here currently exclude NOTHING on production:
 * no approved entry sits on a private post, none is flagged `acceptableMinor`,
 * none is `modelRestricted`, and no host trips the minor ceiling. Every
 * data-driven check of them therefore passes whether the clause is present or
 * absent, and a reviewer reading the query has no way to tell a load-bearing
 * predicate from dead weight. Each of the four was a real gap found by review,
 * not a hypothetical.
 *
 * 🔴 What this file CANNOT do, stated so a green run is not over-read: with no
 * database in this suite it asserts on the SQL the service composes, so for most
 * of these it pins the SPELLING of a clause rather than its effect. It would
 * pass for a predicate that is present and subtly wrong. It exists to stop a
 * clause being DELETED as redundant, which is the failure these four are
 * actually exposed to.
 *
 * If you are here because one of these failed after you simplified the query:
 * the clause you removed was not redundant, it was untested by the data.
 * `getRemixGallery` survives without several of them only because it hydrates
 * through `getAllImages`, which applies its own guards and drops the row. The
 * batched read does not hydrate, so this predicate is the only gate it has.
 */

const queryRaw = dbMock.dbRead.$queryRaw;

/**
 * The full SQL text of a `$queryRaw` tagged-template call.
 *
 * 🔴 Not `strings.join('')`. Prisma passes interpolated `Prisma.sql` fragments as
 * VALUES, not as text, so the entire shared predicate lands in the values array
 * and a naive join of the static strings contains none of it. A test written
 * that way asserts on a string that never held the thing it checks, and passes
 * forever.
 */
type SqlLike = { strings: readonly string[]; values: readonly unknown[] };

/**
 * 🔴 Duck-typed, not `instanceof Prisma.Sql`. `@prisma/client` resolves to a stub
 * in this suite, so `Prisma.Sql` is `undefined` and `instanceof` throws
 * `Right-hand side of 'instanceof' is not an object` — on every assertion at
 * once, which at least fails loudly rather than quietly matching nothing.
 */
const isSql = (value: unknown): value is SqlLike =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as SqlLike).strings) &&
  Array.isArray((value as SqlLike).values);

function renderedSql(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const expand = (value: unknown): string =>
    isSql(value)
      ? value.strings.reduce((out, part, i) => out + part + expand(value.values[i]), '')
      : '';
  return strings.reduce((out, part, i) => out + part + expand(values[i]), '');
}

/** Every bound parameter, including those inside nested fragments. */
function boundValues(call: unknown[]): unknown[] {
  const [, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const flatten = (value: unknown): unknown[] =>
    isSql(value) ? value.values.flatMap(flatten) : [value];
  return values.flatMap(flatten);
}

describe('remix gallery entry visibility', () => {
  beforeEach(() => {
    queryRaw.mockClear();
    queryRaw.mockResolvedValue([]);
  });

  // PG only. Chosen, not arbitrary: it must not collide with
  // `nsfwBrowsingLevelsFlag`, which the modelRestricted assertion looks for by
  // value — a colliding fixture would let the level parameter satisfy that
  // assertion on its own, green on the exact deletion it exists to catch.
  const BROWSING_LEVEL = 1;

  const render = async () => {
    await getRemixGalleryCardSummaries({ imageIds: [1, 2, 3], browsingLevel: BROWSING_LEVEL });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    return renderedSql(queryRaw.mock.calls[0]);
  };

  // The control for everything below. If the renderer stops finding the
  // fragment, every other assertion here passes vacuously and pins nothing.
  it('renders the shared predicate into the batched query at all', async () => {
    const sql = await render();
    expect(sql).toContain('"Placement"');
    expect(sql).toContain('pl.status');
    expect(sql).toContain('i."nsfwLevel"');
  });

  /**
   * 🔴 The creator's content rule, enforced on READ.
   *
   * It used to be enforced by accident: the detail page scoped the gallery to
   * the HOST image's rating, so an entry above the host could not intersect the
   * level. That scoping was removed because it also hid entries from viewers
   * entitled to see them — 161 of 488 approved on prod, 160 paid — and nothing
   * replaced it. A host re-rated down after approval would then keep rendering
   * entries above the band its owner set, for the week approval is locked.
   *
   * ⚠️ Like the rest of this file, this pins the SPELLING of a clause and not
   * its effect: prod has ZERO approved entries that the band would hide today
   * (measured 2026-08-30 by running this exact predicate against the replica),
   * so no data-driven check can distinguish present from absent. The nonzero
   * control that the predicate is not a constant is the other direction — 280
   * of 575 approved entries resolve to `any`, and 80 of those sit above their
   * host and must keep rendering.
   */
  it('applies the host content band, resolved across all three placement scopes', async () => {
    const sql = await render();

    // The comparison itself. Scoped to the ENTRY alias against a host lookup —
    // a bare `nsfwLevel` match would pass on the level filter alone.
    expect(sql).toContain('i."nsfwLevel" <= (SELECT h."nsfwLevel"');
    // The `any` escape hatch, without which a creator who opted into anything
    // goes has their own gallery filtered.
    expect(sql).toContain("= 'any'");

    // 🔴 All three scopes. `resolvePlacementSpace` merges settings PER KEY, so an
    // image with no row of its own inherits its owner's rule — resolving only
    // the image scope reports "no row, so the default" and is wrong for 280 of
    // 575 approved entries on prod.
    for (const scope of ['image', 'post', 'user']) {
      expect(sql, `the ${scope} scope must be resolved`).toContain(`s."entityType" = '${scope}'`);
    }
  });

  it('excludes entries on private posts', async () => {
    expect(await render()).toContain('"availability"');
  });

  it('excludes entries flagged acceptableMinor, which minor alone does not catch', async () => {
    // 🔴 Scoped to the ENTRY alias. A bare `"acceptableMinor"` match passes with
    // this clause deleted, because the minor-host ceiling mentions the same
    // column on the host — measured: removing the entry clause left that
    // assertion green.
    expect(await render()).toContain('NOT i."acceptableMinor"');
  });

  it('applies the minor-host ceiling correlated per host, not pinned to one id', async () => {
    const sql = await render();
    // 🔴 Asserted at the ceiling's own join, not anywhere `pl."targetId"`
    // appears. The column is also in the SELECT list and the PARTITION BY, so a
    // loose match survives the ceiling being pinned to a literal — measured:
    // replacing the correlation with a bound id left that assertion green.
    // A pinned ceiling applies one host's rating to every other host's entries.
    expect(sql).toContain('h.id = pl."targetId"');
    expect(sql).toContain('"acceptableMinor" OR');
  });

  it('gates modelRestricted with both arms, so a NULL cannot empty the SFW half', async () => {
    await render();
    const values = boundValues(queryRaw.mock.calls[0]);
    // The two-arm form binds `nsfwBrowsingLevelsFlag`; a bare
    // `NOT i."modelRestricted"` does not bind it at all. So this fails on that
    // exact simplification, and does not care how the clause is spelled.
    expect(values).toContain(nsfwBrowsingLevelsFlag);
    // Guards the fixture: if these two ever coincide, the assertion above is
    // satisfied by the browsing level alone and stops testing anything.
    expect(nsfwBrowsingLevelsFlag).not.toBe(BROWSING_LEVEL);
  });

  it('binds the browsing level it was given rather than a default', async () => {
    await render();
    expect(boundValues(queryRaw.mock.calls[0])).toContain(BROWSING_LEVEL);
  });

  it('keeps the gates it shares with getAllImages', async () => {
    const sql = await render();
    for (const clause of [
      '"publishedAt"',
      "ingestion = 'Scanned'",
      '"needsReview" IS NULL',
      '"tosViolation"',
      'i.minor',
      'i.poi',
    ])
      expect(sql).toContain(clause);
  });
});
