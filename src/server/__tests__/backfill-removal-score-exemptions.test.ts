import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPolicyChangeRemovals: vi.fn(),
  previewTierUps: vi.fn(),
  insertRemovalScoreExemptions: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {},
}));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbReadLong: {},
  pgDbWrite: {},
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  getScoreMultipliers: async () => ({ reportsAgainst: -1000 }),
}));
vi.mock('~/server/services/removal-score-exemption.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Exemptions>()),
  findPolicyChangeRemovals: mocks.findPolicyChangeRemovals,
  previewTierUps: mocks.previewTierUps,
  insertRemovalScoreExemptions: mocks.insertRemovalScoreExemptions,
}));

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as PgDb from '~/server/db/pgDb';
import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as Exemptions from '~/server/services/removal-score-exemption.service';
import handler from '~/pages/api/admin/temp/backfill-removal-score-exemptions';
import { removalWeight } from '~/shared/utils/creator-removal-weights';
import { REMOVAL_SCORE_WINDOW_DAYS } from '~/shared/constants/creator-journey.constants';

const NOW = new Date('2026-06-01T00:00:00Z');
const seconds = (daysAgo: number) => Math.floor(NOW.getTime() / 1000) - daysAgo * 86_400;

function call(query: Record<string, string>) {
  let body: unknown;
  const res = {
    status: () => res,
    json(payload: unknown) {
      body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  const req = { method: 'GET', headers: {}, query: { token: 'test-webhook-token', ...query } };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => body);
}

const removal = (ownerId: number, imageId: number, daysAgo: number, scoreReason = 'poi') => ({
  ownerId,
  imageId,
  removedAt: seconds(daysAgo),
  lastReason: 'poi', // what exemption matching reads; the score weighs `scoreReason`
  scoreReason,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.previewTierUps.mockResolvedValue({ owners: 0, byTier: {} });
  mocks.insertRemovalScoreExemptions.mockResolvedValue(0);
});
afterEach(() => vi.useRealTimers());

describe('backfill-removal-score-exemptions preview', () => {
  it('gives back points only for removals still inside the window, weighed by reason', async () => {
    mocks.findPolicyChangeRemovals.mockResolvedValue([
      removal(1, 10, 5),
      removal(1, 11, REMOVAL_SCORE_WINDOW_DAYS + 1), // aged out: costs nothing, restores nothing
      removal(2, 12, 5, 'spam'), // half weight
      removal(2, 13, 5, 'other'), // no weight
    ]);

    const body = await call({});

    expect(body).toMatchObject({ images: 4, owners: 2, pointsRestored: 1500 });
    expect(mocks.previewTierUps).toHaveBeenCalledWith(
      expect.anything(),
      new Map([
        [1, 1],
        [2, 0.5],
      ]),
      1000
    );
  });

  it('weighs a removal by the reason the score reads: violationType first, then tosReason', async () => {
    mocks.findPolicyChangeRemovals.mockResolvedValue([
      { ...removal(1, 10, 5, 'spam'), lastReason: 'manual' }, // violationType spam, tosReason manual
    ]);

    const body = await call({});

    expect(removalWeight('spam')).toBe(0.5);
    expect(body).toMatchObject({ pointsRestored: 500 });
  });

  it('still exempts every covered image, aged out or not', async () => {
    mocks.findPolicyChangeRemovals.mockResolvedValue([
      removal(1, 10, 5),
      removal(1, 11, REMOVAL_SCORE_WINDOW_DAYS + 1),
    ]);

    await call({ dryRun: 'false' });

    expect(mocks.insertRemovalScoreExemptions).toHaveBeenCalledWith(
      expect.anything(),
      [10, 11],
      expect.any(String),
      null
    );
  });
});
