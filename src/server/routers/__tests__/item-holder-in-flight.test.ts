import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';
import type * as MysteryBoxService from '~/server/services/mystery-box.service';

/**
 * Driven through `createCaller` so the real middleware chain runs; the services stand in for the
 * lock and block until a test releases them.
 */

const { mockPurchase, mockOpen, gate } = vi.hoisted(() => {
  const gate = {
    open: false,
    pending: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
    releaseAll() {
      gate.open = true;
      gate.pending.splice(0).forEach((p) => p.resolve());
    },
  };
  const block = () =>
    gate.open
      ? Promise.resolve(undefined as never)
      : new Promise<never>((resolve, reject) =>
          gate.pending.push({ resolve: () => resolve(undefined as never), reject })
        );
  return { mockPurchase: vi.fn(block), mockOpen: vi.fn(block), gate };
});

vi.mock('~/server/services/cosmetic-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopService>()),
  purchaseCosmeticShopItem: mockPurchase,
}));
vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  openMysteryBox: mockOpen,
}));

import type { TRPCError } from '@trpc/server';
import { cosmeticShopRouter } from '../cosmetic-shop.router';
import { mysteryBoxRouter } from '../mystery-box.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const user = (id: number) => ({
  id,
  isModerator: false,
  tier: 'free',
  username: `user${id}`,
  onboarding: 0x1f,
  email: `user${id}@example.com`,
  emailVerified: new Date(),
});

const ctx = (userId: number) =>
  ({
    acceptableOrigin: true,
    user: user(userId),
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { mysteryBox: true },
    track: undefined,
  } as never);

const outcomes: string[] = [];
const track = (call: Promise<unknown>) =>
  call.then(
    () => void outcomes.push('admitted'),
    (error: TRPCError) => void outcomes.push(error.code)
  );
const purchase = (userId: number) =>
  track(cosmeticShopRouter.createCaller(ctx(userId)).purchaseShopItem({ shopItemId: 42 }));
const open = (userId: number) =>
  track(mysteryBoxRouter.createCaller(ctx(userId)).open({ boxItemId: '501', expectedVersion: 3 }));

const reached = () => mockPurchase.mock.calls.length + mockOpen.mock.calls.length;
/** Long enough for every mocked store call and the procedure behind an admitted one to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function installSortedSets() {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => sets.get(key) ?? sets.set(key, new Map()).get(key)!;
  const r = redisMock.redis;
  r.zRemRangeByScore
    .mockReset()
    .mockImplementation(async (key: string, _min: string, max: number) => {
      let removed = 0;
      for (const [member, score] of set(key))
        if (score <= max && set(key).delete(member)) removed++;
      return removed;
    });
  r.zAdd.mockReset().mockImplementation(async (key: string, { score, value }) => {
    set(key).set(value, score);
    return 1;
  });
  r.expire.mockReset().mockResolvedValue(true);
  r.zCard.mockReset().mockImplementation(async (key: string) => set(key).size);
  r.zRem
    .mockReset()
    .mockImplementation(async (key: string, member: string) => (set(key).delete(member) ? 1 : 0));
}

beforeEach(() => {
  mockPurchase.mockClear();
  mockOpen.mockClear();
  gate.open = false;
  gate.pending.length = 0;
  outcomes.length = 0;
  installSortedSets();
});
// Finish every pending request so none outlives its test.
afterEach(async () => {
  gate.releaseAll();
  await settle();
});

describe('per-user in-flight limit on purchaseShopItem and mysteryBox.open', () => {
  it('refuses a third purchase or open while two are in flight, without reaching the service', async () => {
    purchase(2);
    open(2);
    await settle();
    expect(reached()).toBe(2);

    // One at a time: simultaneous arrivals can all be refused, which would hide a looser limit.
    for (const call of [purchase, purchase, open, open, purchase]) {
      call(2);
      await settle();
    }

    expect(reached()).toBe(2);
    expect(outcomes).toEqual(Array(5).fill('TOO_MANY_REQUESTS'));
  });

  it('a refused request takes nothing with it: the next one after the two finish is admitted', async () => {
    purchase(2);
    open(2);
    await settle();
    for (const call of [purchase, open, purchase]) call(2);
    await settle();

    gate.pending.splice(0).forEach((p) => p.resolve());
    await settle();
    purchase(2);
    await settle();

    expect(reached()).toBe(3);
  });

  it('shares one bucket between the two procedures', async () => {
    purchase(2);
    purchase(2);
    await settle();

    open(2);
    await settle();

    expect(mockOpen).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['TOO_MANY_REQUESTS']);
  });

  it('counts each user separately', async () => {
    purchase(2);
    open(2);
    await settle();

    purchase(3);
    await settle();

    expect(reached()).toBe(3);
  });

  it('frees the slot when the request finishes, whether it succeeded or threw', async () => {
    purchase(2);
    open(2);
    await settle();
    const [ok, failed] = gate.pending.splice(0);
    ok.resolve();
    failed.reject(new Error('grant failed'));
    await settle();

    purchase(2);
    open(2);
    await settle();

    expect(reached()).toBe(4);
  });

  it('stops counting a slot once it has been held for the slot TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    try {
      purchase(2);
      open(2);
      await settle();

      vi.setSystemTime(1_000_000 + 59_000);
      purchase(2);
      await settle();
      expect(outcomes).toEqual(['TOO_MANY_REQUESTS']);

      vi.setSystemTime(1_000_000 + 60_001);
      purchase(2);
      await settle();
      expect(reached()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['rejects', () => redisMock.redis.zAdd.mockRejectedValue(new Error('redis down'))],
    [
      'answers a count that is not a number',
      () => redisMock.redis.zCard.mockResolvedValue(undefined),
    ],
  ])('admits every request when the store %s', async (_label, arrange) => {
    arrange();

    for (let i = 0; i < 5; i++) purchase(2);
    await settle();

    expect(reached()).toBe(5);
  });

  it('admits a request whose slot the store is too slow to answer, then frees that slot when it lands', async () => {
    const r = redisMock.redis;
    const stalled: Array<() => void> = [];
    const realZAdd = r.zAdd.getMockImplementation()!;
    r.zAdd.mockImplementation(
      (...args: Parameters<typeof realZAdd>) =>
        new Promise((resolve) => stalled.push(() => resolve(realZAdd(...args))))
    );

    purchase(2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reached()).toBe(1);

    stalled.forEach((land) => land());
    await settle();
    expect(r.zRem.mock.calls.map(([, member]) => member)).toEqual([r.zAdd.mock.calls[0][1].value]);
  });
});
