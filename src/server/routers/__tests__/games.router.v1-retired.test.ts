import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NewOrderService from '~/server/services/games/new-order.service';

// Once the v1 Knights game is retired, its player procedures refuse; the moderator procedures that
// settle and drain what players already did stay open.

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
});

const { v1Live, handler } = vi.hoisted(() => ({
  v1Live: vi.fn(async () => true),
  handler: vi.fn(async () => ({})),
}));

vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: v1Live }));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  joinGame: handler,
  getPlayerById: handler,
  getImagesQueue: handler,
  getPlayerHistory: handler,
  addImageRating: handler,
  resetPlayer: handler,
  smitePlayer: handler,
  cleanseSmite: handler,
  getPlayersInfinite: handler,
  getImageRaters: handler,
  manageSanityChecks: handler,
}));

import { OnboardingComplete } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
const { gamesRouter } = await import('~/server/routers/games.router');

const ctxFor = (isModerator: boolean) =>
  ({
    user: { id: 41, username: 'knight', isModerator, onboarding: OnboardingComplete },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'civitai.blue' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

type Caller = ReturnType<typeof gamesRouter.createCaller>['newOrder'];
const PLAYER_PROCEDURES: [string, (c: Caller) => Promise<unknown>][] = [
  ['join', (c) => c.join()],
  ['getPlayer', (c) => c.getPlayer()],
  ['getImagesQueue', (c) => c.getImagesQueue()],
  ['getHistory', (c) => c.getHistory({} as never)],
  ['addRating', (c) => c.addRating({ imageId: 1, rating: 1 } as never)],
  ['resetCareer', (c) => c.resetCareer()],
];

beforeEach(() => {
  handler.mockClear();
  v1Live.mockResolvedValue(true);
});

describe('games.newOrder player procedures', () => {
  it.each(PLAYER_PROCEDURES)('%s refuses once v1 is retired', async (_name, call) => {
    v1Live.mockResolvedValue(false);

    await expect(call(gamesRouter.createCaller(ctxFor(false)).newOrder)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(PLAYER_PROCEDURES)('%s answers while v1 is live', async (_name, call) => {
    await call(gamesRouter.createCaller(ctxFor(false)).newOrder);

    expect(handler).toHaveBeenCalled();
  });
});

describe('games.newOrder player procedures with invalid input', () => {
  const INVALID: [string, (c: Caller) => Promise<unknown>][] = [
    ['getHistory', (c) => c.getHistory({ limit: 'many' } as never)],
    ['addRating', (c) => c.addRating({} as never)],
  ];

  it.each(INVALID)(
    '%s refuses invalid input with FORBIDDEN once v1 is retired',
    async (_name, call) => {
      v1Live.mockResolvedValue(false);

      await expect(call(gamesRouter.createCaller(ctxFor(false)).newOrder)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  );

  it.each(INVALID)(
    '%s still answers BAD_REQUEST to invalid input while v1 is live',
    async (_name, call) => {
      await expect(call(gamesRouter.createCaller(ctxFor(false)).newOrder)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(handler).not.toHaveBeenCalled();
    }
  );
});

describe('games.newOrder moderator procedures', () => {
  it('stay open once v1 is retired, to drain and settle what players did', async () => {
    v1Live.mockResolvedValue(false);
    const caller = gamesRouter.createCaller(ctxFor(true)).newOrder;

    await caller.getPlayers({} as never);
    await caller.getImageRaters({ imageId: 1 });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
