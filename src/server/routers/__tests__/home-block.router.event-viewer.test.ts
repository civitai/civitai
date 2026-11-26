import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

import type * as HomeBlockService from '~/server/services/home-block.service';
import type * as HomeBlockAccess from '~/server/services/home-block-access';

const { svc, filterViewableHomeBlocks } = vi.hoisted(() => ({
  svc: {
    getHomeBlocks: vi.fn<(args: { viewer?: unknown }) => Promise<never[]>>(async () => []),
    getSystemHomeBlocks: vi.fn<(args: unknown) => Promise<never[]>>(async () => []),
    getHomeBlockById: vi.fn<(args: { viewer?: unknown }) => Promise<null>>(async () => null),
    setHomeBlocksOrder: vi.fn<(args: { viewer?: unknown }) => Promise<void>>(async () => undefined),
  },
  filterViewableHomeBlocks: vi.fn<(blocks: unknown[], viewer?: unknown) => Promise<unknown[]>>(
    async (blocks) => blocks
  ),
}));
vi.mock('~/server/services/home-block.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockService>()),
  ...svc,
}));
vi.mock('~/server/services/home-block-access', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockAccess>()),
  filterViewableHomeBlocks,
}));

import type { Context } from '~/server/createContext';
import { homeBlockRouter } from '~/server/routers/home-block.router';
import { createCallerFactory } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

const MODERATOR = { id: 10, isModerator: true };
const credentials = {
  session: {},
  'a scoped personal key': {
    apiKeyId: 5,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey', id: 5 },
    tokenScope: TokenScope.UserRead | TokenScope.UserWrite,
  },
  'an OAuth token': {
    apiKeyId: 6,
    apiKeyType: ApiKeyType.Access,
    subject: { type: 'oauth', id: 'client' },
    tokenScope: TokenScope.Full,
  },
};
const caller = (credential: Record<string, unknown>) =>
  createCallerFactory(homeBlockRouter)({
    user: MODERATOR,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
    features: { canViewNsfw: false },
    ...credential,
  } as unknown as Context);

const ROUTES: [
  route: string,
  call: (c: ReturnType<typeof caller>) => Promise<unknown>,
  viewer: () => unknown
][] = [
  ['getHomeBlocks', (c) => c.getHomeBlocks({}), () => svc.getHomeBlocks.mock.calls[0]?.[0].viewer],
  [
    'getHomeBlocks (system fallback)',
    (c) => c.getHomeBlocks({ systemHomeBlockIds: [1] }),
    () => svc.getHomeBlocks.mock.calls[1]?.[0].viewer,
  ],
  [
    'getSystemHomeBlocks',
    (c) => c.getSystemHomeBlocks({}),
    () => filterViewableHomeBlocks.mock.calls[0]?.[1],
  ],
  [
    'getHomeBlock',
    (c) => c.getHomeBlock({ id: 1 }).catch(() => undefined),
    () => svc.getHomeBlockById.mock.calls[0]?.[0].viewer,
  ],
  [
    'setHomeBlockOrder',
    (c) => c.setHomeBlockOrder({ homeBlocks: [] }),
    () => svc.setHomeBlocksOrder.mock.calls[0]?.[0].viewer,
  ],
];

beforeEach(() => vi.clearAllMocks());

describe.each(['a scoped personal key', 'an OAuth token'] as const)(
  'a moderator on %s',
  (credential) => {
    it.each(ROUTES)('homeBlock.%s asks its gate about the user alone', async (_, call, viewer) => {
      await call(caller(credentials[credential]));
      expect(viewer()).toEqual({ id: MODERATOR.id, isModerator: false });
    });
  }
);

describe('a moderator on a session', () => {
  it.each(ROUTES)('homeBlock.%s asks its gate about the moderator', async (_, call, viewer) => {
    await call(caller(credentials.session));
    expect(viewer()).toEqual({ id: MODERATOR.id, isModerator: true });
  });
});
