import { describe, expect, it } from 'vitest';
import { countPlacements } from '@civitai/db-queries/placement';
import { compileHarness } from '@civitai/db-queries/test-harness';
import {
  freePlacementsOnWhere,
  freePlacementsTodayWhere,
  reservedFreeSlotsWhere,
} from '~/server/services/placement-count-predicates';
import { freePlacementDayStart } from '~/shared/utils/placement';

/**
 * The free-slot and free-allowance predicates exist once each, as where-objects the Prisma count
 * and its Kysely display twin (`countPlacements`) both read. This pins the other half of that
 * contract: every builder's object is one `countPlacements` can translate. A Prisma operator the
 * translator does not know (`notIn`, `not`, `lt`, a null) would make it throw — here, in CI —
 * rather than only on the flag-on path in production.
 */
const compile = async (where: Parameters<typeof countPlacements>[1]) => {
  const harness = compileHarness();
  await countPlacements(harness.db, where);
  expect(harness.queries).toHaveLength(1);
  return harness.lastQuery();
};

describe('the shared placement count predicates translate to Kysely', () => {
  it('reservedFreeSlotsWhere', async () => {
    const { sql, parameters } = await compile(
      reservedFreeSlotsWhere({ surface: 'sticker', targetType: 'image', targetId: 4101 })
    );
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "surface" = $1 and "targetType" = $2 ' +
        'and "targetId" = $3 and "free" = $4 and "status" in ($5, $6)'
    );
    expect(parameters).toEqual(['sticker', 'image', 4101, true, 'pending', 'approved']);
  });

  it('freePlacementsTodayWhere', async () => {
    const { sql, parameters } = await compile(freePlacementsTodayWhere(4202));
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "placerId" = $1 and "free" = $2 ' +
        'and "createdAt" >= $3::timestamp'
    );
    expect(parameters).toEqual([4202, true, freePlacementDayStart().toISOString()]);
  });

  it('freePlacementsOnWhere', async () => {
    const { sql, parameters } = await compile(
      freePlacementsOnWhere({
        placerId: 4303,
        surface: 'remixGallery',
        targetType: 'image',
        targetId: 4404,
      })
    );
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "placerId" = $1 and "free" = $2 ' +
        'and "surface" = $3 and "targetType" = $4 and "targetId" = $5'
    );
    expect(parameters).toEqual([4303, true, 'remixGallery', 'image', 4404]);
  });
});
