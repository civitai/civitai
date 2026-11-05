import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';

// Where the Kysely placement reads reach, not what the ports return (that is
// placement-reads.kysely.test.ts): nothing outside the placement read chain moves onto Kysely
// with it. Any flag read answers false, without a Flipt client.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// `getPlacementConfig`'s KeyValue read: no stored row, so the compiled defaults apply.
const { getKeyValue } = vi.hoisted(() => ({ getKeyValue: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getKeyValue,
}));

import * as queries from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { isFlipt } from '~/server/flipt/client';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { getCapTier } from '~/server/services/subscriptions.service';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

const OWNER = 5101;
const IMAGE = 5202;

const goldSubscription = {
  id: 'sub-gold',
  status: 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: null,
  metadata: {},
  buzzType: 'yellow',
  product: {
    id: 'prod-gold',
    name: 'Gold',
    description: null,
    metadata: { tier: 'gold' },
    provider: 'Civitai',
    active: true,
  },
  price: {
    id: 'price-gold',
    unitAmount: 5000,
    interval: 'month',
    intervalCount: 1,
    currency: 'usd',
    active: true,
  },
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of Object.values(q)) if (vi.isMockFunction(fn)) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getKeyValue.mockReset().mockResolvedValue(undefined);
  dbMock.dbWrite.customerSubscription.findMany.mockResolvedValue([goldSubscription]);
  q.getImagePlacementTarget.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: null,
    type: 'image',
    username: 'creator',
  } as never);
  q.listPlacementSpacesFor.mockResolvedValue([] as never);
  q.getUserPlacementScore.mockResolvedValue([{ score: 26_000 }] as never);
  q.listUserSubscriptionRows.mockResolvedValue([goldSubscription] as never);
});

describe('Kysely placement reads scope', () => {
  it('a space resolution reads the price range through Kysely once each', async () => {
    const space = await resolvePlacementSpaceFor({
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
    });

    // The config's KeyValue read, by its key alone.
    expect(getKeyValue.mock.calls.map((call) => call[1])).toEqual(['placement:config']);
    expect(q.getUserPlacementScore).toHaveBeenCalledTimes(1);
    expect(q.listUserSubscriptionRows).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.customerSubscription.findMany).not.toHaveBeenCalled();
    expect(space.cap).toBe(2500); // gold at 26k: the tier and score reached the answer
  });

  // Early access, the model-version pricing allowance and announcements call getCapTier(userId).
  // They are not placement reads and stay on Prisma.
  it('getCapTier from a non-placement caller reads Prisma', async () => {
    await expect(getCapTier(OWNER)).resolves.toBe('gold');

    expect(dbMock.dbWrite.customerSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(q.listUserSubscriptionRows).not.toHaveBeenCalled();
  });
});
