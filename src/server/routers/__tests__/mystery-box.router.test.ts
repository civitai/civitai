import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MysteryBoxService from '~/server/services/mystery-box.service';
import type * as MysteryBoxOddsPageService from '~/server/services/mystery-box-odds-page.service';
import type * as MysteryBoxInventoryService from '~/server/services/mystery-box-inventory.service';

/**
 * The kill switch and region block reach the open here: the router reads the `mysteryBox` flag and
 * the holder's country, and the service trusts what it is handed. Driven through `createCaller` so
 * the real procedure builds the arguments.
 */

const { mockOpen, mockRead, mockCatalog, mockOddsPage, mockHeld, mockOpenings } = vi.hoisted(
  () => ({
    mockOpen: vi.fn(async () => ({ replayed: false })),
    mockRead: vi.fn(async () => []),
    mockCatalog: vi.fn(async () => []),
    mockOddsPage: vi.fn(async () => null),
    mockHeld: vi.fn(async () => []),
    mockOpenings: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  })
);

vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  openMysteryBox: mockOpen,
  getMysteryBoxesForEvent: mockRead,
  getMysteryBoxCatalogForEvent: mockCatalog,
}));

vi.mock('~/server/services/mystery-box-odds-page.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxOddsPageService>()),
  getMysteryBoxOddsPage: mockOddsPage,
}));

vi.mock('~/server/services/mystery-box-inventory.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxInventoryService>()),
  getHeldMysteryBoxes: mockHeld,
  getMysteryBoxOpenings: mockOpenings,
}));

import { mysteryBoxRouter } from '../mystery-box.router';
import { openMysteryBoxInput } from '~/server/schema/mystery-box.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const holder = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'holder',
  onboarding: 0x1f,
  email: 'holder@example.com',
  emailVerified: new Date(),
};

const caller = (
  features: Record<string, boolean>,
  headers: Record<string, string> = {},
  ctx: { user?: typeof holder | null; apiKeyId?: number | null } = {}
) =>
  mysteryBoxRouter.createCaller({
    acceptableOrigin: true,
    user: holder,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: features as never,
    track: undefined,
    ...ctx,
  } as never);

const open = (
  features: Record<string, boolean>,
  headers: Record<string, string> = {},
  input: { boxItemId: string; expectedVersion: number } = { boxItemId: '501', expectedVersion: 3 },
  ctx: { user?: typeof holder | null; apiKeyId?: number | null } = {}
) =>
  mysteryBoxRouter
    .createCaller({
      acceptableOrigin: true,
      user: holder,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: features as never,
      track: undefined,
      ...ctx,
    } as never)
    .open(input);

const rejectsWithCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toMatchObject({ code });
};

describe('mysteryBox.open hands the service the flag, the country and the holder', () => {
  beforeEach(() => mockOpen.mockClear());

  it('passes the mysteryBox flag through, on and off', async () => {
    await open({ mysteryBox: true });
    await open({ mysteryBox: false });
    expect(
      mockOpen.mock.calls.map(([arg]) => (arg as { mysteryBoxEnabled?: boolean }).mysteryBoxEnabled)
    ).toEqual([true, false]);
  });

  it('passes the country from the request and the signed-in user', async () => {
    await open({ mysteryBox: true }, { 'cf-ipcountry': 'BE' });
    expect(mockOpen).toHaveBeenCalledWith({
      boxItemId: '501',
      expectedVersion: 3,
      userId: holder.id,
      isModerator: false,
      mysteryBoxEnabled: true,
      countryCode: 'BE',
    });
  });

  it.each([['0'], ['-1'], ['1.5'], ['9223372036854775808'], ['99999999999999999999'], ['abc']])(
    'refuses box id %s as a bad request, before the service',
    async (boxItemId) => {
      await rejectsWithCode(
        open({ mysteryBox: true }, {}, { boxItemId, expectedVersion: 3 }),
        'BAD_REQUEST'
      );
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );

  it.each([[0], [-1], [1.5]])('refuses expected version %s', async (expectedVersion) => {
    await rejectsWithCode(
      open({ mysteryBox: true }, {}, { boxItemId: '501', expectedVersion }),
      'BAD_REQUEST'
    );
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it.each([['1.5'], ['abc'], ['99999999999999999999']])(
    'the schema answers box id %s with an issue, not a thrown error',
    (boxItemId) => {
      // zod runs the refine even after the regex fails, so a BigInt() there would throw.
      expect(openMysteryBoxInput.safeParse({ boxItemId, expectedVersion: 3 }).success).toBe(false);
    }
  );

  it.each([
    ['1'],
    ['99'],
    ['95000'],
    ['9300000000'],
    ['1000000000000000000'],
    ['9223372036854775806'],
    ['9223372036854775807'],
  ])('the schema accepts box id %s', (boxItemId) => {
    expect(openMysteryBoxInput.safeParse({ boxItemId, expectedVersion: 3 }).success).toBe(true);
  });

  it('accepts the largest BIGINT id', async () => {
    await open({ mysteryBox: true }, {}, { boxItemId: '9223372036854775807', expectedVersion: 3 });
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('refuses a signed-out caller and an API key', async () => {
    await rejectsWithCode(
      open({ mysteryBox: true }, {}, undefined, { user: null }),
      'UNAUTHORIZED'
    );
    await rejectsWithCode(open({ mysteryBox: true }, {}, undefined, { apiKeyId: 7 }), 'FORBIDDEN');
    expect(mockOpen).not.toHaveBeenCalled();
  });
});

describe('mysteryBox.getForEvent hands the service the flag, the country and the viewer', () => {
  beforeEach(() => mockRead.mockClear());

  it('passes the flag, the country, the viewer and their moderator bit', async () => {
    await caller({ mysteryBox: true }, { 'cf-ipcountry': 'BE' }).getForEvent({
      event: 'birthday2026',
    });
    await caller({ mysteryBox: false }, {}, { user: { ...holder, isModerator: true } }).getForEvent(
      { event: 'birthday2026' }
    );
    expect(mockRead.mock.calls.map(([arg]) => arg)).toEqual([
      {
        event: 'birthday2026',
        userId: holder.id,
        isModerator: false,
        mysteryBoxEnabled: true,
        countryCode: 'BE',
      },
      {
        event: 'birthday2026',
        userId: holder.id,
        isModerator: true,
        mysteryBoxEnabled: false,
        // No country header: unknown, which the service hides boxes for whenever any is blocked.
        countryCode: undefined,
      },
    ]);
  });

  it('refuses a signed-out caller', async () => {
    await rejectsWithCode(
      caller({ mysteryBox: true }, {}, { user: null }).getForEvent({ event: 'birthday2026' }),
      'UNAUTHORIZED'
    );
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('mysteryBox.getCatalogForEvent hands the service the flag, the country and the viewer', () => {
  beforeEach(() => mockCatalog.mockClear());

  it('serves a signed-out visitor as no viewer, and a signed-in one with their moderator bit', async () => {
    await caller({ mysteryBox: true }, { 'cf-ipcountry': 'BE' }, { user: null }).getCatalogForEvent(
      { event: 'birthday2026' }
    );
    await caller(
      { mysteryBox: false },
      {},
      { user: { ...holder, isModerator: true } }
    ).getCatalogForEvent({ event: 'birthday2026' });
    expect(mockCatalog.mock.calls.map(([arg]) => arg)).toEqual([
      { event: 'birthday2026', viewer: undefined, mysteryBoxEnabled: true, countryCode: 'BE' },
      {
        event: 'birthday2026',
        viewer: { id: holder.id, isModerator: true },
        mysteryBoxEnabled: false,
        countryCode: undefined,
      },
    ]);
  });
});

// A signed-out request is edge-cached for a minute by default, keyed by URL alone; these answers
// depend on the visitor's country and flags.
describe('the public box reads are never edge-cached', () => {
  it.each([
    [
      'getCatalogForEvent',
      (c: ReturnType<typeof mysteryBoxRouter.createCaller>) =>
        c.getCatalogForEvent({ event: 'birthday2026' }),
    ],
    [
      'getOddsPage',
      (c: ReturnType<typeof mysteryBoxRouter.createCaller>) =>
        c.getOddsPage({ boxDefinitionId: 9 }),
    ],
  ])('%s zeroes the signed-out edge and browser cache', async (_, call) => {
    const cache = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30, canCache: true };
    const signedOut = mysteryBoxRouter.createCaller({
      acceptableOrigin: true,
      user: null,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {} } as never,
      res: { setHeader: () => undefined } as never,
      cache,
      features: { mysteryBox: true } as never,
      track: undefined,
    } as never);

    await call(signedOut);

    expect(cache).toMatchObject({ edgeTTL: 0, browserTTL: 0 });
  });
});

describe('mysteryBox.getOddsPage hands the service the flag, the country and the viewer', () => {
  beforeEach(() => mockOddsPage.mockClear());

  it('serves a signed-out visitor as no viewer, and a signed-in one with their moderator bit', async () => {
    await caller({ mysteryBox: true }, { 'cf-ipcountry': 'BE' }, { user: null }).getOddsPage({
      boxDefinitionId: 9,
    });
    await caller({ mysteryBox: false }, {}, { user: { ...holder, isModerator: true } }).getOddsPage(
      {
        boxDefinitionId: 9,
      }
    );
    await caller({ mysteryBox: true }).getOddsPage({ boxDefinitionId: 9 });
    expect(mockOddsPage.mock.calls.map(([arg]) => arg)).toEqual([
      { boxDefinitionId: 9, viewer: undefined, mysteryBoxEnabled: true, countryCode: 'BE' },
      {
        boxDefinitionId: 9,
        viewer: { id: holder.id, isModerator: true },
        mysteryBoxEnabled: false,
        countryCode: undefined,
      },
      {
        boxDefinitionId: 9,
        viewer: { id: holder.id, isModerator: false },
        mysteryBoxEnabled: true,
        countryCode: undefined,
      },
    ]);
  });

  it.each([0, -1, 2_147_483_648, 1.5])('refuses box id %s before the service', async (id) => {
    await rejectsWithCode(
      caller({ mysteryBox: true }).getOddsPage({ boxDefinitionId: id }),
      'BAD_REQUEST'
    );
    expect(mockOddsPage).not.toHaveBeenCalled();
  });
});

describe('the Inventory reads hand the service the flag, the country and the viewer', () => {
  beforeEach(() => {
    mockHeld.mockClear();
    mockOpenings.mockClear();
  });

  it('getHeld passes the flag, the country, the viewer and their moderator bit', async () => {
    await caller({ mysteryBox: true }, { 'cf-ipcountry': 'BE' }).getHeld();
    await caller({ mysteryBox: false }, {}, { user: { ...holder, isModerator: true } }).getHeld();
    expect(mockHeld.mock.calls.map(([arg]) => arg)).toEqual([
      { userId: holder.id, isModerator: false, mysteryBoxEnabled: true, countryCode: 'BE' },
      { userId: holder.id, isModerator: true, mysteryBoxEnabled: false, countryCode: undefined },
    ]);
  });

  it('getOpenings passes the same, with the page asked for', async () => {
    await caller({ mysteryBox: true }, { 'cf-ipcountry': 'BE' }).getOpenings({
      limit: 5,
      cursor: '33',
    });
    await caller({ mysteryBox: false }).getOpenings({});
    expect(mockOpenings.mock.calls.map(([arg]) => arg)).toEqual([
      {
        limit: 5,
        cursor: '33',
        userId: holder.id,
        isModerator: false,
        mysteryBoxEnabled: true,
        countryCode: 'BE',
      },
      {
        limit: 20,
        userId: holder.id,
        isModerator: false,
        mysteryBoxEnabled: false,
        countryCode: undefined,
      },
    ]);
  });

  it.each([['9223372036854775808'], ['0'], ['abc']])(
    'getOpenings refuses cursor %s as a bad request, before the service',
    async (cursor) => {
      await rejectsWithCode(caller({ mysteryBox: true }).getOpenings({ cursor }), 'BAD_REQUEST');
      expect(mockOpenings).not.toHaveBeenCalled();
    }
  );

  it('refuses a signed-out caller', async () => {
    const signedOut = caller({ mysteryBox: true }, {}, { user: null });
    await rejectsWithCode(signedOut.getHeld(), 'UNAUTHORIZED');
    await rejectsWithCode(signedOut.getOpenings({}), 'UNAUTHORIZED');
    expect(mockHeld).not.toHaveBeenCalled();
    expect(mockOpenings).not.toHaveBeenCalled();
  });
});
