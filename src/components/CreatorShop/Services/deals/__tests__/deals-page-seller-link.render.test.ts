import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Service Requests page lists what the viewer requested. A seller's incoming requests live on
// their shop Manage page, so a seller gets a link there and a non-seller gets none.

const mocks = vi.hoisted(() => ({
  user: { id: 9, username: 'seller' } as { id: number; username: string } | null,
  offerings: [] as { id: number }[],
  hiddenOffDomain: 0,
  creatorShop: true,
  enabled: [] as boolean[],
}));

vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/server/services/creator-service.service', () => ({ hasOpenServiceDeal: () => false }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/CreatorShop/Services/deals/ServiceDealsList', () => ({
  ServiceDealsList: ({ role }: { role: string }) => createElement('div', { 'data-list': role }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorShop: mocks.creatorShop }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/components/CreatorShop/Services/creator-service.util', () => ({
  useQueryMyServices: (enabled: boolean) => {
    mocks.enabled.push(enabled);
    return { offerings: mocks.offerings, hiddenOffDomain: mocks.hiddenOffDomain, isLoading: false };
  },
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

const { default: Page } = await import('~/pages/services/deals/index');

const render = (openOnly = false) =>
  renderToStaticMarkup(createElement(MantineProvider, null, createElement(Page, { openOnly })));

beforeEach(() => {
  mocks.user = { id: 9, username: 'seller' };
  mocks.offerings = [];
  mocks.hiddenOffDomain = 0;
  mocks.creatorShop = true;
  mocks.enabled = [];
});

describe('Service Requests page seller link', () => {
  it('links a seller to the Incoming requests on their shop Manage page', () => {
    mocks.offerings = [{ id: 1 }];
    const html = render();
    expect(html).toContain('href="/user/seller/shop/manage?tab=services"');
    expect(html).toContain('Incoming requests');
  });

  it('keeps the link when services are paused but seller still has services', () => {
    mocks.offerings = [{ id: 1 }];
    expect(render(true)).toContain('/shop/manage?tab=services');
  });

  it('links a seller whose services are all hidden off this domain', () => {
    mocks.hiddenOffDomain = 2;
    expect(render()).toContain('/shop/manage?tab=services');
  });

  it('shows a viewer with no services no link', () => {
    expect(render()).not.toContain('/shop/manage');
  });

  it('shows no link while the shop is off, since Manage would send the seller to their profile', () => {
    mocks.offerings = [{ id: 1 }];
    mocks.creatorShop = false;
    expect(render()).not.toContain('/shop/manage');
  });

  it('shows no link before the viewer is known', () => {
    mocks.user = null;
    mocks.offerings = [{ id: 1 }];
    expect(render()).not.toContain('/shop/manage');
    expect(mocks.enabled).toEqual([false]);
  });
});
