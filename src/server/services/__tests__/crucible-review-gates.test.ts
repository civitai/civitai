import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import { NsfwLevel } from '~/server/common/enums';
import { dbMock, loggingMock } from '~/__tests__/mocks';

const refundMultiAccountTransaction = vi.fn();
const createNotification = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const {
  getFeaturedCrucible,
  getJudgingSuggestions,
  isCrucibleHiddenByScan,
  voidUnscannedCrucibles,
} = await import('~/server/services/crucible.service');

const CREATOR = 4;
const HOUR = 60 * 60 * 1000;

describe('isCrucibleHiddenByScan', () => {
  const crucible = (
    ingestion: CrucibleIngestionStatus,
    cover: ImageIngestionStatus | null = ImageIngestionStatus.Scanned
  ) => ({ userId: CREATOR, ingestion, image: cover ? { ingestion: cover } : null });

  it('shows a crucible whose text and cover both passed', () => {
    expect(isCrucibleHiddenByScan(crucible(CrucibleIngestionStatus.Scanned), { viewerId: 9 })).toBe(
      false
    );
  });

  it.each([
    ['text pending', crucible(CrucibleIngestionStatus.Pending)],
    ['text blocked', crucible(CrucibleIngestionStatus.Blocked)],
    ['text scan errored', crucible(CrucibleIngestionStatus.Error)],
    [
      'cover not scanned yet',
      crucible(CrucibleIngestionStatus.Scanned, ImageIngestionStatus.Pending),
    ],
    ['cover blocked', crucible(CrucibleIngestionStatus.Scanned, ImageIngestionStatus.Blocked)],
    ['no cover', crucible(CrucibleIngestionStatus.Scanned, null)],
  ])('hides it from everyone else with %s', (_, row) => {
    expect(isCrucibleHiddenByScan(row, { viewerId: 9 })).toBe(true);
    expect(isCrucibleHiddenByScan(row, {})).toBe(true);
  });

  it('never hides it from its creator or a moderator', () => {
    const pending = crucible(CrucibleIngestionStatus.Pending, ImageIngestionStatus.Pending);
    expect(isCrucibleHiddenByScan(pending, { viewerId: CREATOR })).toBe(false);
    expect(isCrucibleHiddenByScan(pending, { viewerId: 9, isModerator: true })).toBe(false);
  });
});

describe('voidUnscannedCrucibles', () => {
  const findMany = dbMock.dbRead.crucible.findMany;
  const findUnique = dbMock.dbWrite.crucible.findUnique;
  const claim = dbMock.dbWrite.crucible.updateMany;
  const now = new Date('2026-10-01T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR);

  const unscanned = (
    id: number,
    {
      text = CrucibleIngestionStatus.Scanned,
      cover = ImageIngestionStatus.Scanned as ImageIngestionStatus | null,
      startedHoursAgo = 1,
      updatedHoursAgo = startedHoursAgo,
    } = {}
  ) => ({
    id,
    userId: CREATOR,
    ingestion: text,
    startAt: hoursAgo(startedHoursAgo),
    updatedAt: hoursAgo(updatedHoursAgo),
    image: cover ? { ingestion: cover } : null,
  });
  const cancelledIds = () =>
    claim.mock.calls
      .filter(([arg]) => arg.data.status === CrucibleStatus.Cancelled)
      .map(([arg]) => arg.where.id);

  beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => ({
      id: where.id,
      userId: CREATOR,
      status: CrucibleStatus.Pending,
      entryFee: 10,
      buzzTransactionId: `crucible-setup-${where.id}`,
      seededPrizePool: 0,
      seedTransactionId: null,
      entries: [],
    }));
    claim.mockResolvedValue({ count: 1 });
    refundMultiAccountTransaction.mockResolvedValue(undefined);
    createNotification.mockResolvedValue(undefined);
  });

  it('only asks for crucibles it will void: blocked, or unreviewed past the grace, so ones in their grace cannot starve the rest', async () => {
    findMany.mockResolvedValue([]);

    await voidUnscannedCrucibles(now);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: [CrucibleStatus.Pending, CrucibleStatus.Active] },
          startAt: { lte: now },
          entries: { none: {} },
          OR: [
            { ingestion: CrucibleIngestionStatus.Blocked },
            { image: { ingestion: ImageIngestionStatus.Blocked } },
            {
              startAt: { lt: hoursAgo(24) },
              updatedAt: { lt: hoursAgo(24) },
              OR: [
                { ingestion: { not: CrucibleIngestionStatus.Scanned } },
                { image: { is: null } },
                { image: { ingestion: { not: ImageIngestionStatus.Scanned } } },
              ],
            },
          ],
        },
      })
    );
  });

  it('cancels a blocked text or cover at once, and an unfinished review only after a day', async () => {
    findMany.mockResolvedValue([
      unscanned(1, { text: CrucibleIngestionStatus.Blocked }),
      unscanned(2, { cover: ImageIngestionStatus.Blocked }),
      unscanned(3, { text: CrucibleIngestionStatus.Pending, startedHoursAgo: 2 }),
      unscanned(4, { text: CrucibleIngestionStatus.Error, startedHoursAgo: 25 }),
      unscanned(5, { cover: null, startedHoursAgo: 25 }),
    ]);

    expect(await voidUnscannedCrucibles(now)).toEqual([1, 2, 4, 5]);
    expect(cancelledIds()).toEqual([1, 2, 4, 5]);
  });

  it('counts the day from the edit that reset the review, not from the start', async () => {
    findMany.mockResolvedValue([
      unscanned(1, {
        text: CrucibleIngestionStatus.Pending,
        startedHoursAgo: 60,
        updatedHoursAgo: 1,
      }),
    ]);

    expect(await voidUnscannedCrucibles(now)).toEqual([]);
    expect(cancelledIds()).toEqual([]);
  });

  it('refunds the creator and tells them why', async () => {
    findMany.mockResolvedValue([unscanned(1, { text: CrucibleIngestionStatus.Blocked })]);

    await voidUnscannedCrucibles(now);

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'crucible-setup-1' })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CREATOR,
        key: 'crucible-unscanned-cancelled-1',
        details: expect.objectContaining({
          message: expect.stringMatching(/Terms of Service.*has been refunded/),
        }),
      })
    );
  });

  it("records a refund it couldn't make, and doesn't claim it was made", async () => {
    findMany.mockResolvedValue([unscanned(1, { text: CrucibleIngestionStatus.Blocked })]);
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz 500'));

    await voidUnscannedCrucibles(now);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-unscanned-void-refund-failed',
        crucibleId: 1,
      })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ message: expect.stringMatching(/being processed/) }),
      })
    );
  });
});

describe('list surfaces — featured and judging suggestions', () => {
  const queryRaw = dbMock.dbRead.$queryRaw;
  /** A `$queryRaw` call rendered in order, nested `Prisma.sql` inline and bound values as `?`. */
  const render = (strings: readonly string[], values: unknown[]): string =>
    strings
      .map((text, i) => {
        if (i >= values.length) return text;
        const value = values[i] as { strings?: string[]; values?: unknown[] };
        return text + (value?.strings ? render(value.strings, value.values ?? []) : '?');
      })
      .join('');
  const sqlText = (call: unknown[]) => render(call[0] as string[], call.slice(1));

  beforeEach(() => {
    vi.clearAllMocks();
    queryRaw.mockResolvedValue([]);
  });

  it.each([
    ['featured', () => getFeaturedCrucible({ browsingLevel: 1 })],
    ['judging suggestions', () => getJudgingSuggestions({ userId: 7, browsingLevel: 1, limit: 4 })],
  ])(
    '%s: only crucibles whose text and cover passed, and no adult text for a SFW viewer',
    async (_, run) => {
      await run();

      const sql = sqlText(queryRaw.mock.calls[0]);
      expect(sql).toContain('c.ingestion =');
      expect(sql).toContain('i.ingestion =');
      expect(sql).toContain('NOT c."textNsfw"');
    }
  );

  it('featured: ranks by a pool that counts only paid entries', async () => {
    await getFeaturedCrucible({ browsingLevel: 1 });

    const pool = sqlText(queryRaw.mock.calls[0])
      .split('as "prizePool"')[0]
      .split('as "entriesCount"')[1];
    expect(pool).toContain('FILTER (WHERE ce."buzzTransactionId" IS NOT NULL)');
  });

  it.each([
    ['featured', (isGreen: boolean) => getFeaturedCrucible({ browsingLevel: 1, isGreen })],
    [
      'judging suggestions',
      (isGreen: boolean) =>
        getJudgingSuggestions({ userId: 7, browsingLevel: 1, limit: 4, isGreen }),
    ],
  ])('%s: lists any currency, and only SFW crucibles on the green site', async (_, run) => {
    await run(true);
    const green = sqlText(queryRaw.mock.calls.at(-1)!);
    expect(green).not.toContain('"buzzType"');
    expect(green).toContain('AND c."nsfwLevel" = ANY(?::int[]) AND NOT c."textNsfw"');
    const greenSite = (queryRaw.mock.calls.at(-1)!.slice(1) as { strings?: string[] }[]).find(
      (value) => value?.strings?.join('?').includes('NOT c."textNsfw"')
    ) as { values: unknown[] };
    expect(greenSite.values).toEqual([
      [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.PG | NsfwLevel.PG13],
    ]);

    await run(false);
    const red = sqlText(queryRaw.mock.calls.at(-1)!);
    expect(red).not.toContain('"buzzType"');
    expect(red).not.toContain('= ANY(?::int[]) AND NOT c."textNsfw"');
  });

  it('suggestions count only entries this judge could be shown', async () => {
    await getJudgingSuggestions({ userId: 7, browsingLevel: 1, limit: 4 });

    const judgeable = sqlText(queryRaw.mock.calls[0])
      .split('judgeable')[0]
      .split('FROM "CrucibleEntry" ce')[1];
    expect(judgeable).toContain('JOIN "Image" i');
    expect(judgeable).toContain('i.ingestion =');
  });

  it('caps the level to SFW on the green site for suggestions', async () => {
    await getJudgingSuggestions({ userId: 7, browsingLevel: 31, limit: 4, isGreen: true });

    const values = queryRaw.mock.calls[0].slice(1).flatMap(function flat(value): unknown[] {
      const nested = (value as { values?: unknown[] })?.values;
      return Array.isArray(nested) ? nested.flatMap(flat) : [value];
    });
    expect(values).not.toContain(31);
  });
});
