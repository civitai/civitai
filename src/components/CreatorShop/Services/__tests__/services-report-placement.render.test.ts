import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Where the storefront offers the options menu (which holds Report), and on which offering. The menu's items are pinned in
// ServiceOfferingMenu.browser.test.tsx; here it is a stand-in that shows what it was given.

const mocks = vi.hoisted(() => ({ viewerId: 1 as number | null }));

vi.mock('~/components/CreatorShop/Services/ServiceOfferingMenu', () => ({
  ServiceOfferingMenu: ({ offering, isOwner }: { offering: { id: number }; isOwner: boolean }) =>
    createElement('span', { 'data-menu-offering': offering.id, 'data-menu-owner': isOwner }),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.viewerId == null ? null : { id: mocks.viewerId }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryShopServices: () => ({
    offerings: [
      {
        id: 42,
        title: 'Portrait commission',
        description: 'One portrait.',
        price: 500,
        deliveryDays: 5,
        revisionsIncluded: 1,
        maxNsfwLevel: 2,
        slotsOpen: null,
      },
    ],
    isLoading: false,
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/deal.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMyServiceDeals: () => ({ deals: [], hasNextPage: false, hiddenOffDomain: 0 }),
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceRequestModal', () => ({
  ServiceRequestModal: () => null,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: () => undefined } }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));

const { ServicesSection } = await import('~/components/CreatorShop/Storefront/ServicesSection');

// The seller's id (9) differs from the offering's (42), so a report filed on the wrong one shows.
const SELLER = 9;
const renderShop = (shopPublished = true) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServicesSection, {
        ownerUserId: SELLER,
        username: 'seller',
        shopPublished,
      })
    )
  );

beforeEach(() => {
  mocks.viewerId = 1;
});

describe('storefront: reporting a service', () => {
  it('gives a visitor the options menu on that offering, beside Request', () => {
    const html = renderShop();
    expect(html).toContain('data-menu-offering="42"');
    expect(html).toContain('data-menu-owner="false"');
    expect(html).toContain('Request');
  });

  it('offers no Request on a draft shop, which answers a buyer "Shop not found" (a moderator can see it)', () => {
    const html = renderShop(false);
    expect(html).not.toContain('Request');
    expect(html).toContain('data-menu-offering="42"');
  });

  it('tells the menu the seller is the owner on their own storefront', () => {
    mocks.viewerId = SELLER;
    expect(renderShop()).toContain('data-menu-owner="true"');
  });
});
