import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EventService from '~/server/services/event.service';

vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

const { service, navBanners, watch, moderatorOnly } = vi.hoisted(() => {
  const ok = () => vi.fn(async () => ({ ok: 1 }));
  const moderatorOnly = async ({ viewer }: { viewer?: { isModerator?: boolean } }) =>
    viewer?.isModerator ? 'open' : 'closed';
  return {
    moderatorOnly,
    service: {
      getViewerEventAccess: vi.fn(moderatorOnly),
      activateEventCosmetic: ok(),
      donate: ok(),
      getEventCosmetic: ok(),
      getEventData: ok(),
      getEventRewards: ok(),
      getTeamScoreHistory: ok(),
      getTeamScores: ok(),
      getEventContributors: ok(),
      getUserRank: ok(),
      getEventPartners: ok(),
      getEventStandings: ok(),
      getMyEventCosmeticScores: ok(),
      getEventCosmeticScores: ok(),
      getEventHatCatalog: ok(),
      getMyEventHats: ok(),
      getPlaceableEventContent: ok(),
      getPlaceableEventContentPage: ok(),
      getWornEventHat: ok(),
      getTeamRoster: ok(),
      getMyRosterStatus: ok(),
      setRosterOptIn: ok(),
      getMyShowcaseHat: ok(),
      getMyShowcaseHatArt: ok(),
      setShowcaseHat: ok(),
    },
    navBanners: { getNavBanners: vi.fn(async () => []) },
    watch: {
      markEventPointsWatched: vi.fn<(input: unknown, viewer: unknown) => Promise<{ ok: number }>>(
        async () => ({ ok: 1 })
      ),
    },
  };
});
vi.mock('~/server/services/event.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EventService>()),
  ...service,
}));
vi.mock('~/server/services/nav-banner.service', () => navBanners);
vi.mock('~/server/events/points/watch.service', () => watch);

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { eventRouter } from '~/server/routers/event.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

type Ctx = Record<string, unknown> & { user?: { id: number; isModerator?: boolean } };
type Middleware = (opts: {
  input?: unknown;
  ctx: Ctx;
  next: (opts?: { ctx?: Partial<Ctx> }) => unknown;
  path: string;
  getRawInput: () => Promise<unknown>;
  type: string;
  meta?: unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

const procedures = (
  eventRouter as unknown as {
    _def: {
      procedures: Record<
        string,
        { _def: { middlewares: Middleware[]; meta?: unknown; type?: string } }
      >;
    };
  }
)._def.procedures;

const MODERATOR = { id: 10, isModerator: true };
const credentials = {
  session: {},
  'a scoped personal key': {
    apiKeyId: 5,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey', id: 5 },
    tokenScope: TokenScope.MediaRead | TokenScope.SocialWrite | TokenScope.UserWrite,
  },
  'an OAuth token': {
    apiKeyId: 6,
    apiKeyType: ApiKeyType.Access,
    subject: { type: 'oauth', id: 'client' },
    tokenScope: TokenScope.Full,
  },
};

const ctxFor = (credential: Record<string, unknown>): Ctx => ({
  user: MODERATOR,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
  features: {},
  ip: '127.0.0.1',
  ...credential,
});

const BASE_INPUT = {
  event: 'unlaunched',
  cosmetics: [],
  entityType: 'Image',
  entityId: 1,
  team: 'Blue',
  topics: ['a'],
  optIn: true,
  cosmeticId: 1,
};

async function run(name: string, ctx: Ctx) {
  const { middlewares, type } = procedures[name]._def;
  const input = BASE_INPUT;
  let i = 0;
  const step = async (c: Ctx): Promise<unknown> => {
    if (i >= middlewares.length) return { ok: true, data: undefined, marker: undefined, ctx: c };
    const result = (await middlewares[i++]({
      input,
      ctx: c,
      path: `event.${name}`,
      getRawInput: async () => input,
      type: type ?? 'query',
      meta: procedures[name]._def.meta,
      next: (opts?: { ctx?: Partial<Ctx> }) => step(opts?.ctx ? { ...c, ...opts.ctx } : c),
    })) as { ok: boolean; error?: unknown };
    if (result && result.ok === false) throw result.error;
    return result;
  };
  return step(ctx);
}

const ROUTES: [route: string, fn: string, passed: 'viewer' | 'user'][] = [
  ['getAccess', 'getViewerEventAccess', 'viewer'],
  ['getData', 'getEventData', 'viewer'],
  ['getTeamScores', 'getTeamScores', 'viewer'],
  ['getTeamScoreHistory', 'getTeamScoreHistory', 'viewer'],
  ['getCosmetic', 'getEventCosmetic', 'user'],
  ['getPartners', 'getEventPartners', 'viewer'],
  ['getRewards', 'getEventRewards', 'viewer'],
  ['activateCosmetic', 'activateEventCosmetic', 'user'],
  ['getDonors', 'getEventContributors', 'viewer'],
  ['getStandings', 'getEventStandings', 'viewer'],
  ['getHatCatalog', 'getEventHatCatalog', 'viewer'],
  ['getMyCosmeticScores', 'getMyEventCosmeticScores', 'user'],
  ['getCosmeticScores', 'getEventCosmeticScores', 'viewer'],
  ['getWornHat', 'getWornEventHat', 'viewer'],
  ['getMyHats', 'getMyEventHats', 'user'],
  ['getPlaceableContent', 'getPlaceableEventContent', 'user'],
  ['getPlaceableContentPage', 'getPlaceableEventContentPage', 'user'],
  ['getTeamRoster', 'getTeamRoster', 'viewer'],
  ['getMyRosterStatus', 'getMyRosterStatus', 'user'],
  ['setRosterOptIn', 'setRosterOptIn', 'user'],
  ['getMyShowcaseHat', 'getMyShowcaseHat', 'user'],
  ['setShowcaseHat', 'setShowcaseHat', 'user'],
  ['getUserRank', 'getUserRank', 'user'],
];
const GATED_ROUTES = [
  'getData',
  'getTeamScores',
  'getTeamScoreHistory',
  'getPartners',
  'getRewards',
  'getDonors',
  'getStandings',
  'getHatCatalog',
  'getCosmeticScores',
  'getWornHat',
  'getTeamRoster',
];
const GATED = ROUTES.filter(([route]) => GATED_ROUTES.includes(route));
const fnOf = (name: string) => (service as Record<string, ReturnType<typeof vi.fn>>)[name];
const lastViewer = (fn: string, passed: 'viewer' | 'user') => {
  const calls = fnOf(fn).mock.calls;
  return (calls[calls.length - 1][0] as Record<string, unknown>)[passed];
};

beforeEach(() => {
  vi.clearAllMocks();
  service.getViewerEventAccess.mockImplementation(moderatorOnly);
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

it('covers every route of the event router that takes a viewer', () => {
  const covered = new Set([...ROUTES.map(([r]) => r), 'getNavBanners', 'watchPoints']);
  const exempt = new Set(['donate', 'getMyShowcaseHatArt']);
  expect(Object.keys(procedures).filter((r) => !covered.has(r) && !exempt.has(r))).toEqual([]);
});

describe.each(['a scoped personal key', 'an OAuth token'] as const)(
  'a moderator on %s',
  (credential) => {
    const ctx = () => ctxFor(credentials[credential]);

    it.each(GATED)('is refused an unlaunched event at event.%s’s gate', async (route, fn) => {
      await expect(run(route, ctx())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(fnOf(fn)).not.toHaveBeenCalled();
    });

    it.each(ROUTES)('event.%s asks %s about the user alone', async (route, fn, passed) => {
      service.getViewerEventAccess.mockResolvedValue('open');
      await run(route, ctx());
      expect(lastViewer(fn, passed)).toEqual({ id: MODERATOR.id, isModerator: false });
    });

    it('event.getNavBanners and event.watchPoints ask about the user alone', async () => {
      await run('getNavBanners', ctx());
      await run('watchPoints', ctx());
      expect(navBanners.getNavBanners).toHaveBeenCalledWith({
        viewer: { id: MODERATOR.id, isModerator: false },
      });
      expect(watch.markEventPointsWatched.mock.calls[0]?.[1]).toEqual({
        id: MODERATOR.id,
        isModerator: false,
      });
    });
  }
);

// Control: without it, the scoped-token answers above would also pass if moderators were dropped
// everywhere.
describe('a moderator on a session', () => {
  it.each(GATED)('passes event.%s’s gate for the unlaunched event', async (route, fn) => {
    await run(route, ctxFor(credentials.session));
    expect(fnOf(fn)).toHaveBeenCalledTimes(1);
  });

  it.each(ROUTES)('event.%s asks %s about the moderator', async (route, fn, passed) => {
    await run(route, ctxFor(credentials.session));
    expect(lastViewer(fn, passed)).toEqual({ id: MODERATOR.id, isModerator: true });
  });
});
