import { beforeEach, expect, it, vi } from 'vitest';

import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';

const { getShopSectionsWithItems } = vi.hoisted(() => ({
  getShopSectionsWithItems: vi.fn(async () => []),
}));
vi.mock('~/server/services/cosmetic-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopService>()),
  getShopSectionsWithItems,
}));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

import type { Context } from '~/server/createContext';
import { cosmeticShopRouter } from '~/server/routers/cosmetic-shop.router';
import { createCallerFactory } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The shop's moderator flag decides which event items show before launch, so it is a moderator's
 * only on a session or a full-access personal key (eventViewerOf), as for moderatorProcedure.
 */
const MODERATOR = { id: 10, isModerator: true };
const credentials = {
  session: {},
  'a scoped personal key': {
    apiKeyId: 5,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey', id: 5 },
    tokenScope: TokenScope.CollectionsRead,
  },
  'an OAuth token': {
    apiKeyId: 6,
    apiKeyType: ApiKeyType.Access,
    subject: { type: 'oauth', id: 'client' },
    tokenScope: TokenScope.Full,
  },
};
const getShop = (credential: Record<string, unknown>) =>
  createCallerFactory(cosmeticShopRouter)({
    user: MODERATOR,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
    features: {},
    ...credential,
  } as unknown as Context).getShop({});
const isModeratorPassed = () => getShopSectionsWithItems.mock.calls[0][0].isModerator;

beforeEach(() => vi.clearAllMocks());

it.each(['a scoped personal key', 'an OAuth token'] as const)(
  'cosmeticShop.getShop reads a moderator on %s as a user',
  async (credential) => {
    await getShop(credentials[credential]);
    expect(isModeratorPassed()).toBe(false);
  }
);

it('cosmeticShop.getShop reads a moderator on a session as a moderator', async () => {
  await getShop(credentials.session);
  expect(isModeratorPassed()).toBe(true);
});
