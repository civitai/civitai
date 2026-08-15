import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { UserEngagementType } from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What `isPlacementBlocked` resolves against real rows, as opposed to what its
 * SQL says.
 *
 * `placement-moderation.service.test.ts` mocks `$queryRaw` and asserts on the
 * template text — that it mentions `UserEngagement` and `Block`, and that both
 * orderings of the pair appear. That is a check on a string, and composed
 * `Prisma.sql` assertions in this repo have read out of order before, so an
 * `AND` → `OR` flip inside the predicate is invisible to it: the same fragments
 * are still present, still counted, still in the text. Only executing the
 * predicate can tell those apart.
 *
 * So this file runs the real, unmodified query on an in-process Postgres and
 * asserts on the answer.
 */

// The mock factory below is hoisted above the imports, so it closes over this
// holder rather than over an instance that does not exist yet.
const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    // Prisma's `$queryRaw` is a tagged template. Stitch the fragments back into
    // a parameterized statement and run it, so the service's SQL reaches
    // Postgres exactly as written.
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      let sql = '';
      for (let i = 0; i < strings.length; i++) {
        sql += strings[i];
        if (i < values.length) sql += `$${i + 1}`;
      }
      return holder.db.query(sql, values as unknown[]).then((r) => r.rows);
    },
    placementSuspension: { findUnique: async () => null },
  },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('~/server/services/placement-escrow.service', () => ({ settlePlacement: vi.fn() }));

const { isPlacementBlocked } = await import('~/server/services/placement-moderation.service');

const BLOCKER = 9000001;
const BLOCKED = 9000002;
// No row in either direction.
const STRANGER = 9000003;

/**
 * One partner per non-block engagement type, derived from the enum rather than
 * listed.
 *
 * Each is engaged with BLOCKER and differs from the blocked pair in the
 * engagement type and nothing else, so `type = 'Block'` is the only thing that
 * can exclude them — a predicate widened to `IN ('Block','Hide')` would refuse
 * legitimate paid placements between users who merely hid each other, and has
 * nowhere to hide here.
 *
 * Deriving it means a fourth enum value arrives as a new negative control rather
 * than as a silent gap: hardcoding three values leaves a widened predicate green
 * after an edit in a file nobody would think to connect to this one. The gate
 * that makes that work is `db:check-generated`, not this file — the enum is a
 * generated artifact, so a schema edit that is never regenerated reaches neither.
 *
 * Each partner is seeded in both directions. Seeding one way puts every negative
 * control on the same arm of the predicate, and a `type` check that ended up on
 * only the other arm would then pass everything here while refusing legitimate
 * placements in production.
 */
const NON_BLOCK_PARTNERS = Object.values(UserEngagementType)
  .filter((type) => type !== UserEngagementType.Block)
  .map((type, index) => ({ type, userId: 9000010 + index }));

beforeAll(async () => {
  holder.db = new PGlite();
  // The real column is `UserEngagementType`, not text. A `text` stand-in accepts
  // predicates Postgres rejects on the enum — `type LIKE 'Block%'` runs there and
  // is a hard error in production — so executing the query proves less than it
  // looks if the column type is not the production one.
  await holder.db.exec(`
    CREATE TYPE "UserEngagementType" AS ENUM (${Object.values(UserEngagementType)
      .map((type) => `'${type}'`)
      .join(', ')});
    CREATE TABLE "UserEngagement" (
      "userId"       integer NOT NULL,
      "targetUserId" integer NOT NULL,
      type           "UserEngagementType" NOT NULL,
      PRIMARY KEY ("userId", "targetUserId")
    );
    INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES
      (${BLOCKER}, ${BLOCKED}, '${UserEngagementType.Block}')${NON_BLOCK_PARTNERS.map(
    ({ userId, type }) =>
      `,\n      (${userId}, ${BLOCKER}, '${type}'),\n      (${BLOCKER}, ${userId}, '${type}')`
  ).join('')};
  `);
});

/**
 * Whether the seeded pair is matched by the positional half of the predicate on
 * its own.
 *
 * A negative control only proves anything while its row exists and still lines
 * up with one of the two directional arms. Without this, dropping the row or
 * flipping its direction leaves the control asserting `false` about a pair that
 * has no row at all — green, vacuous, and silent about the rule it was added to
 * pin.
 */
const pairIsSeeded = async (a: number, b: number) => {
  const rows = await holder.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "UserEngagement"
     WHERE ("userId" = $1 AND "targetUserId" = $2) OR ("userId" = $2 AND "targetUserId" = $1)`,
    [a, b]
  );
  return rows.rows[0]?.count ?? 0;
};

describe('the block predicate, executed', () => {
  // `it.each` over an empty table registers nothing, reports green, and warns
  // about neither — so the negative controls below can vanish without a word.
  // Its own test, because the thing it guards cannot guard itself.
  it('has a negative control for every non-block engagement type', () => {
    // An absolute floor first: the count below is derived from the same enum, so
    // an enum that collapsed to Block alone would satisfy it with zero controls.
    expect(NON_BLOCK_PARTNERS.length).toBeGreaterThan(0);
    expect(NON_BLOCK_PARTNERS).toHaveLength(Object.values(UserEngagementType).length - 1);
  });

  it('sees the block from the blocker side', async () => {
    await expect(isPlacementBlocked({ ownerId: BLOCKED, placerId: BLOCKER })).resolves.toBe(true);
  });

  // The row is one-directional; the guard must not be. Someone who blocked a
  // creator must not be able to place on them either, so the reversed argument
  // order has to reach the same answer from the same single row.
  it('sees the same block with the two users swapped', async () => {
    await expect(isPlacementBlocked({ ownerId: BLOCKER, placerId: BLOCKED })).resolves.toBe(true);
  });

  // Without these a predicate that ignores `type` — or one whose conjunction
  // became a disjunction, or one widened to another enum value — reports an
  // engaged pair as blocked and refuses a sale that should go through.
  it.each(NON_BLOCK_PARTNERS)('does not treat a $type as a block', async ({ userId }) => {
    expect(await pairIsSeeded(BLOCKER, userId)).toBeGreaterThan(0);

    await expect(isPlacementBlocked({ ownerId: BLOCKER, placerId: userId })).resolves.toBe(false);
    await expect(isPlacementBlocked({ ownerId: userId, placerId: BLOCKER })).resolves.toBe(false);
  });

  // The control that stops "always true" passing everything above. The count
  // pins the other half of it: this pair is unblocked because it has no row,
  // which is the claim, rather than because someone seeded one later.
  it('reports an unrelated pair as unblocked', async () => {
    expect(await pairIsSeeded(BLOCKED, STRANGER)).toBe(0);

    await expect(isPlacementBlocked({ ownerId: BLOCKED, placerId: STRANGER })).resolves.toBe(false);
  });

  // A blocked pair is two users, not one id appearing somewhere in the row. An
  // `OR` where the predicate wants `AND` matches on the blocker alone, and every
  // pair that user is in then reads as blocked.
  it('does not match a pair that shares only one of the two users', async () => {
    await expect(isPlacementBlocked({ ownerId: BLOCKER, placerId: STRANGER })).resolves.toBe(false);
  });
});
