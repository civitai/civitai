import { beforeEach, expect, it, vi } from 'vitest';

import type * as CosmeticShopService from '~/server/services/cosmetic-shop.service';

const { getShopSectionsWithItems, purchaseCosmeticShopItem } = vi.hoisted(() => ({
  getShopSectionsWithItems: vi.fn<(input: { isModerator?: boolean }) => Promise<never[]>>(
    async () => []
  ),
  purchaseCosmeticShopItem: vi.fn<(input: { isModerator?: boolean }) => Promise<{ ok: boolean }>>(
    async () => ({ ok: true })
  ),
}));
vi.mock('~/server/services/cosmetic-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopService>()),
  getShopSectionsWithItems,
  purchaseCosmeticShopItem,
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
const callerFor = (credential: Record<string, unknown>) =>
  createCallerFactory(cosmeticShopRouter)({
    user: { ...MODERATOR, onboarding: 0x1f, email: 'mod@example.com', emailVerified: new Date() },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
    features: {},
    ...credential,
  } as unknown as Context);
const getShop = (credential: Record<string, unknown>) => callerFor(credential).getShop({});
const isModeratorPassed = () => getShopSectionsWithItems.mock.calls[0]?.[0].isModerator;
const purchase = (credential: Record<string, unknown>) =>
  callerFor(credential).purchaseShopItem({ shopItemId: 42, expectedVersion: 3 });
const purchaseModerator = () => purchaseCosmeticShopItem.mock.calls[0]?.[0].isModerator;

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

it('cosmeticShop.purchaseShopItem refuses an OAuth token before the purchase', async () => {
  await expect(purchase(credentials['an OAuth token'])).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(purchaseCosmeticShopItem).not.toHaveBeenCalled();
});

// An OAuth credential that carries no key id passes blockApiKeys; the moderator flag must still
// come from eventViewerOf.
it('cosmeticShop.purchaseShopItem reads a moderator on an OAuth credential as a user', async () => {
  await purchase({ apiKeyType: ApiKeyType.Access, subject: { type: 'oauth', id: 'client' } });
  expect(purchaseModerator()).toBe(false);
});

it('cosmeticShop.purchaseShopItem reads a moderator on a session as a moderator', async () => {
  await purchase(credentials.session);
  expect(purchaseModerator()).toBe(true);
});
