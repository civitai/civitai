import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chQuery = vi.hoisted(() => vi.fn());
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { query: chQuery },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { excludedRecord } from '~/server/jobs/appeal-decision-records';
import {
  getMyRemovedImages,
  REMOVAL_REASON,
  REMOVALS_QUERY,
  REMOVED_IMAGES_LIMIT,
} from '~/server/services/creator-removed-images.service';
import { removalsQuery } from '~/server/services/creator-removals.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const USER = 42;
// Fixtures remove images at tiny epoch times, or around 1.7e9 seconds; `now` keeps each inside the window.
const EARLY = new Date(10_000);
const RECENT = new Date(1_700_000_400_000);

type State = {
  imageId: number;
  excluded?: boolean;
  owned?: boolean;
  blockedFor?: string | null;
  needsReview?: string | null;
};

const sqlOf = (args: unknown[]) => {
  const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
};

function given({
  events,
  states,
  excludedImages = [],
  excludedOwners = [],
}: {
  // JSONEachRow can return integers as strings.
  events: { imageId: number | string; removedAt: number | string }[];
  states: State[];
  excludedImages?: number[];
  excludedOwners?: number[];
}) {
  chQuery.mockResolvedValue({ json: async () => events });
  const stateRows = states.map((s) => ({
    excluded: false,
    owned: true,
    blockedFor: 'moderated',
    needsReview: null,
    ...s,
  }));
  // No removal here was reversed on appeal; creator-removals.behavior.test.ts covers that rule.
  dbMock.dbRead.$queryRaw.mockImplementation(((...args: unknown[]) =>
    Promise.resolve(sqlOf(args).sql.includes('FROM "Appeal"') ? [] : stateRows)) as never);
  // `getAppealExcludedIds` runs for real; these answer its two queries for the ids they are asked.
  dbMock.dbWrite.$queryRaw.mockImplementation(((...args: unknown[]) => {
    const { sql, values } = sqlOf(args);
    const asked = (values[0] ?? []) as number[];
    const answer = (ids: number[]) =>
      Promise.resolve(ids.filter((id) => asked.includes(id)).map((id) => ({ id })));
    if (sql.includes('jsonb_array_elements')) return answer(excludedImages);
    if (sql.includes('"UserReport"')) return answer(excludedOwners);
    // `getHoldMarkerBlockedImageIds`: no hold kept any of these; creator-removals.behavior.test.ts covers one.
    if (sql.includes('"EvidenceHoldImage"'))
      return Promise.resolve((values[1] as number[]).map((id) => ({ id, blocked: false })));
    throw new Error(`unexpected query: ${sql}`);
  }) as never);
}

beforeEach(() => {
  chQuery.mockReset();
});

describe('getMyRemovedImages', () => {
  it('lists one row per removed image, as many as the Reports against count', async () => {
    given({
      events: [
        { imageId: 3, removedAt: 1_700_000_300 },
        { imageId: 2, removedAt: 1_700_000_200 },
        { imageId: 1, removedAt: 1_700_000_100 },
      ],
      states: [{ imageId: 1 }, { imageId: 2 }, { imageId: 3 }],
    });

    const result = await getMyRemovedImages(USER, RECENT);

    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.items.map((i) => i.imageId)).toEqual([3, 2, 1]);
    expect(result.items[0]).toEqual({
      removedAt: new Date(1_700_000_300_000),
      reason: REMOVAL_REASON,
      imageId: 3,
      canAppeal: true,
    });
  });

  it('reads the caller’s removals through the definition the score counts', async () => {
    given({ events: [], states: [] });

    await getMyRemovedImages(USER, EARLY);

    expect(chQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: REMOVALS_QUERY,
        query_params: { userId: USER, windowStart: expect.any(Number) },
      })
    );
    expect(REMOVALS_QUERY.startsWith(removalsQuery('ownerId = {userId:Int32}'))).toBe(true);
    expect(REMOVALS_QUERY).toMatch(/^\s*ORDER BY removedAt DESC$/m);
    // The score job counts through the same definition.
    const scoreJob = readFileSync(
      join(process.cwd(), 'src/server/jobs/update-user-score.ts'),
      'utf8'
    );
    expect(scoreJob).toContain('removalPenaltyWeightsByOwner(ctx.ch, owners, now)');
    expect(scoreJob).not.toContain("'DeleteTOS'");
  });

  it('judges each removal with the appeal flow’s excludedRecord', async () => {
    given({ events: [{ imageId: 1, removedAt: 1 }], states: [{ imageId: 1 }] });

    await getMyRemovedImages(USER, EARLY);

    const query = sqlOf(dbMock.dbRead.$queryRaw.mock.lastCall!);
    expect(query.sql).toContain(`${excludedRecord(Prisma.raw('r')).sql} AS excluded`);
    expect(query.values).toContainEqual([1]);
  });

  it('leaves out a removal excludedRecord flags', async () => {
    given({
      events: [
        { imageId: 2, removedAt: 2 },
        { imageId: 1, removedAt: 1 },
      ],
      states: [{ imageId: 1 }, { imageId: 2, excluded: true }],
    });

    const result = await getMyRemovedImages(USER, EARLY);

    expect(result.items.map((i) => i.imageId)).toEqual([1]);
    expect(result.total).toBe(1);
  });

  it('leaves out an image the appeal flow’s report lookup excludes', async () => {
    given({
      events: [
        { imageId: 2, removedAt: 2 },
        { imageId: 1, removedAt: 1 },
      ],
      states: [{ imageId: 1 }, { imageId: 2 }],
      excludedImages: [2],
    });

    const result = await getMyRemovedImages(USER, EARLY);

    expect(result.items.map((i) => i.imageId)).toEqual([1]);
    expect(result.total).toBe(1);
  });

  it('lists nothing for an owner the appeal flow excludes', async () => {
    given({
      events: [{ imageId: 1, removedAt: 1 }],
      states: [{ imageId: 1 }],
      excludedOwners: [USER],
    });

    expect(await getMyRemovedImages(USER, EARLY)).toEqual({
      total: 0,
      truncated: false,
      items: [],
    });
  });

  it('leaves out a removal it could not check', async () => {
    given({
      events: [
        { imageId: 2, removedAt: 2 },
        { imageId: 1, removedAt: 1 },
      ],
      states: [{ imageId: 1 }],
    });

    expect((await getMyRemovedImages(USER, EARLY)).items.map((i) => i.imageId)).toEqual([1]);
  });

  it('gives a purged image only its date and reason', async () => {
    given({
      events: [{ imageId: 9, removedAt: 5 }],
      states: [{ imageId: 9, owned: false, blockedFor: null }],
    });

    expect((await getMyRemovedImages(USER, EARLY)).items).toEqual([
      { removedAt: new Date(5000), reason: REMOVAL_REASON, imageId: null, canAppeal: false },
    ]);
  });

  it('offers an appeal only where the appeal flow would accept one', async () => {
    given({
      events: [
        { imageId: 1, removedAt: 4 },
        { imageId: 2, removedAt: 3 },
        { imageId: 3, removedAt: 2 },
        { imageId: 4, removedAt: 1 },
        { imageId: 5, removedAt: 0 },
      ],
      states: [
        { imageId: 1 },
        { imageId: 2 },
        { imageId: 3, needsReview: 'appeal' },
        { imageId: 4, blockedFor: null },
        { imageId: 5, owned: false },
      ],
    });
    // Newest first, as asked: image 1's later approval lifted the block its earlier rejection upheld.
    dbMock.dbRead.appeal.findMany.mockResolvedValue([
      { entityId: 1, status: AppealStatus.Approved },
      { entityId: 2, status: AppealStatus.Rejected },
      { entityId: 1, status: AppealStatus.Rejected },
    ] as never);

    const result = await getMyRemovedImages(USER, EARLY);

    expect(result.items.map((i) => [i.imageId, i.canAppeal])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [null, false],
    ]);
    expect(dbMock.dbRead.appeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: EntityType.Image, userId: USER, entityId: { in: [1, 2, 3, 4] } },
        orderBy: { id: 'desc' },
      })
    );
  });

  it('links an image only while the caller still owns it', async () => {
    given({ events: [{ imageId: 1, removedAt: 1 }], states: [{ imageId: 1 }] });

    await getMyRemovedImages(USER, EARLY);

    expect(sqlOf(dbMock.dbRead.$queryRaw.mock.lastCall!).sql).toContain('coalesce(i."userId" = ');
    expect(sqlOf(dbMock.dbRead.$queryRaw.mock.lastCall!).values).toContain(USER);
  });

  it('says when the list stops at the limit', async () => {
    const events = Array.from({ length: REMOVED_IMAGES_LIMIT }, (_, i) => ({
      imageId: i + 1,
      removedAt: 1,
    }));
    given({ events, states: events.map((e) => ({ imageId: e.imageId })) });

    const result = await getMyRemovedImages(USER, EARLY);

    expect(result.truncated).toBe(true);
    expect(REMOVALS_QUERY).toContain(`LIMIT ${REMOVED_IMAGES_LIMIT}
`);
  });

  // ClickHouse applies the window and the zero-weight reasons before ORDER BY and LIMIT; this stands
  // in for it by reading the filters off the query it is sent.
  const serve = (rows: { imageId: number; removedAt: number; reason: string | null }[]) =>
    chQuery.mockImplementation(async ({ query, query_params }) => {
      const excluded = (/NOT IN \(([^)]*)\)/.exec(query)?.[1] ?? '').match(/[^',\s]+/g) ?? [];
      const start = query_params.windowStart as number | undefined;
      const limit = Number(/LIMIT (\d+)/.exec(query)![1]);
      const json = rows
        .filter((r) => start === undefined || r.removedAt > start)
        .filter((r) => !excluded.includes(r.reason ?? ''))
        .sort((a, b) => b.removedAt - a.removedAt)
        .slice(0, limit);
      return { json: async () => json };
    });

  it('lists a counted removal that more than the limit of newer, cost-free ones would crowd out', async () => {
    const WINDOW_START = 2000;
    const now = new Date((WINDOW_START + 182 * 86_400) * 1000);
    const rows = [
      ...Array.from({ length: REMOVED_IMAGES_LIMIT + 1 }, (_, i) => ({
        imageId: i + 1,
        removedAt: 6000 + i,
        reason: 'other',
      })),
      { imageId: 5000, removedAt: 5000, reason: 'realPerson' },
    ];
    given({ events: [], states: rows.map((r) => ({ imageId: r.imageId })) });
    serve(rows);

    const result = await getMyRemovedImages(USER, now);

    expect(result.items.map((i) => i.imageId)).toEqual([5000]);
    expect(result.truncated).toBe(false);
  });

  it('does not call the list truncated for rows the window drops', async () => {
    const WINDOW_START = 2000;
    const now = new Date((WINDOW_START + 182 * 86_400) * 1000);
    const rows = [
      { imageId: 1, removedAt: 5000, reason: null },
      ...Array.from({ length: REMOVED_IMAGES_LIMIT }, (_, i) => ({
        imageId: i + 2,
        removedAt: 1000 + i,
        reason: 'realPerson',
      })),
    ];
    given({ events: [], states: rows.map((r) => ({ imageId: r.imageId })) });
    serve(rows);

    const result = await getMyRemovedImages(USER, now);

    expect(result.items.map((i) => i.imageId)).toEqual([1]);
    expect(result.truncated).toBe(false);
  });

  it('still says it stopped at the limit when some of those rows are left out', async () => {
    const events = Array.from({ length: REMOVED_IMAGES_LIMIT }, (_, i) => ({
      imageId: i + 1,
      removedAt: 1,
    }));
    given({ events, states: events.map((e) => ({ imageId: e.imageId })), excludedImages: [1] });

    const result = await getMyRemovedImages(USER, EARLY);

    expect(result.total).toBe(REMOVED_IMAGES_LIMIT - 1);
    expect(result.truncated).toBe(true);
  });

  it('reads ids and times ClickHouse returns as strings', async () => {
    given({
      events: [{ imageId: '7', removedAt: '1700000000' }],
      states: [{ imageId: 7 }],
      excludedImages: [8],
    });

    expect((await getMyRemovedImages(USER, RECENT)).items).toEqual([
      {
        removedAt: new Date(1_700_000_000_000),
        reason: REMOVAL_REASON,
        imageId: 7,
        canAppeal: true,
      },
    ]);
  });

  it('checks string ids against the exclusion as numbers', async () => {
    given({
      events: [{ imageId: '7', removedAt: '1700000000' }],
      states: [{ imageId: 7 }],
      excludedImages: [7],
    });

    expect((await getMyRemovedImages(USER, RECENT)).items).toEqual([]);
  });

  it('fails rather than answering an empty list when ClickHouse fails', async () => {
    given({ events: [], states: [] });
    chQuery.mockRejectedValue(new Error('timeout'));

    await expect(getMyRemovedImages(USER, EARLY)).rejects.toThrow('timeout');
  });
});
