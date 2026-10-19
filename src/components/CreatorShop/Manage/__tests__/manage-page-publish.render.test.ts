import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// The manage page decides who the banner counts services for. Rendered whole, so that wiring is
// pinned too (the banner and the helper are covered on their own beside this).

const mocks = vi.hoisted(() => ({
  user: { id: 1, username: 'Seller', isModerator: false } as {
    id: number;
    username: string;
    isModerator: boolean;
  },
  flags: { creatorServices: true } as Record<string, boolean>,
  cosmetics: [] as unknown[],
  cosmeticsLoading: false,
  offerings: [{ status: 'Active' }] as { status: string }[],
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: { username: 'Seller' }, replace: () => undefined }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => mocks.flags }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'userProfile.get': { useQuery: () => ({ data: { id: 1 } }) },
  }),
}));
vi.mock('~/components/CreatorShop/creator-shop.util', () => ({
  useQueryCreatorShopManage: () => ({ items: mocks.cosmetics, isLoading: mocks.cosmeticsLoading }),
  useQueryCreatorShopSettings: () => ({ settings: { enabled: false } }),
  useQueryCreatorShopResaleStats: () => ({ resaleStats: undefined }),
  useMutateCreatorShop: () => ({
    archiveItem: {},
    setItemListed: {},
    unarchiveItem: {},
    deleteItem: {},
    updateSettings: { mutate: () => undefined, isPending: false },
  }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryMyServices: (enabled: boolean) => ({
    offerings: enabled ? mocks.offerings : [],
    hiddenOffDomain: 0,
    eligibility: undefined,
    isLoading: false,
  }),
}));
// Parts of the page that are not under test.
vi.mock('~/components/CreatorShop/Services/ManageServicesPanel', () => ({
  ManageServicesPanel: () => null,
}));
vi.mock('~/components/CreatorShop/Manage/ManageHeader', () => ({ ManageHeader: () => null }));
vi.mock('~/components/CreatorShop/Manage/ManageEmptyState', () => ({
  ManageEmptyState: () => null,
}));
vi.mock('~/components/CreatorShop/Manage/ManageStats', () => ({ ManageStats: () => null }));
vi.mock('~/components/CreatorShop/Manage/ManageToolbar', () => ({ ManageToolbar: () => null }));
vi.mock('~/components/CreatorShop/Manage/ManageItemsTable', () => ({
  ManageItemsTable: () => null,
}));
vi.mock('~/components/Profile/ProfileLayout2', () => ({ UserProfileLayout: () => null }));

const { default: ManageShopPage } = await import('~/pages/user/[username]/shop/manage');

const render = () =>
  renderToStaticMarkup(createElement(MantineProvider, null, createElement(ManageShopPage)));
const publishDisabled = (html: string) =>
  /<button[^>]*\bdisabled\b[^>]*>[\s\S]*?Publish shop/.test(html);

beforeEach(() => {
  mocks.user = { id: 1, username: 'Seller', isModerator: false };
  mocks.flags = { creatorServices: true };
  mocks.cosmetics = [];
  mocks.cosmeticsLoading = false;
  mocks.offerings = [{ status: ServiceOfferingStatus.Active }];
});

describe('manage page: publishing a shop', () => {
  it('lets the owner of a services-only shop publish it', () => {
    const html = render();
    expect(html).toContain('Publish shop');
    expect(publishDisabled(html)).toBe(false);
  });

  it('lets an owner with cosmetics and no services publish', () => {
    mocks.flags = { creatorServices: false };
    mocks.cosmetics = [{}];
    expect(publishDisabled(render())).toBe(false);
  });

  it('does not block Publish while the cosmetics are still loading', () => {
    mocks.flags = { creatorServices: false };
    mocks.offerings = [];
    mocks.cosmeticsLoading = true;
    expect(publishDisabled(render())).toBe(false);
  });

  it('does not count services for an owner without the services flag', () => {
    mocks.flags = { creatorServices: false };
    expect(publishDisabled(render())).toBe(true);
  });

  it("does not count the seller's services when a moderator publishes for them", () => {
    mocks.user = { id: 99, username: 'Moderator', isModerator: true };
    expect(publishDisabled(render())).toBe(true);
  });
});
