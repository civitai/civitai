import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The seller's own storefront card: where a visitor sees Request, the seller gets Manage and,
// with open requests on that service, "Open deal (N)".

const SELLER = 9;
const mocks = vi.hoisted(() => ({
  viewerId: 9 as number | null,
  deals: [] as { id: number; offering: { id: number } }[],
  hasNextPage: false,
  hiddenOffDomain: 0,
  dealsEnabled: [] as boolean[],
}));

vi.mock('~/components/CreatorShop/Services/ReportServiceButton', () => ({
  ReportServiceButton: () => createElement('span', null, 'Report'),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
  useMyServiceDeals: ({ enabled }: { enabled: boolean }) => {
    mocks.dealsEnabled.push(enabled);
    return {
      deals: enabled ? mocks.deals : [],
      hasNextPage: enabled && mocks.hasNextPage,
      hiddenOffDomain: enabled ? mocks.hiddenOffDomain : 0,
    };
  },
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceRequestModal', () => ({
  ServiceRequestModal: () => null,
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dialogStore: { trigger: () => undefined },
}));
vi.mock('~/hooks/useDomainColor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDomainColor: () => 'green',
}));

const { ServicesSection } = await import('~/components/CreatorShop/Storefront/ServicesSection');

const MANAGE = '/user/seller/shop/manage?tab=services';
const deal = (id: number, offeringId = 42) => ({ id, offering: { id: offeringId } });
const render = () =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServicesSection, {
        ownerUserId: SELLER,
        username: 'seller',
        shopPublished: true,
      })
    )
  );
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

beforeEach(() => {
  mocks.viewerId = SELLER;
  mocks.deals = [];
  mocks.hasNextPage = false;
  mocks.hiddenOffDomain = 0;
  mocks.dealsEnabled = [];
});

describe("seller's own service card", () => {
  it('shows Manage, linking to the services tab, and no Request', () => {
    const html = render();
    expect(html).toContain('Manage');
    expect(hrefs(html)).toContain(MANAGE);
    expect(html).not.toContain('Request');
    expect(html).not.toContain('Open deal');
  });

  it('opens the one open deal on that service directly', () => {
    mocks.deals = [deal(7), deal(8, 99)];
    const html = render();
    expect(html).toContain('Open deal (1)');
    expect(hrefs(html)).toContain('/services/deals/7');
    expect(hrefs(html)).not.toContain('/services/deals/8');
  });

  it('sends several open deals to the list, with the count', () => {
    mocks.deals = [deal(7), deal(6)];
    const html = render();
    expect(html).toContain('Open deal (2)');
    expect(hrefs(html).filter((h) => h === MANAGE)).toHaveLength(2);
    expect(hrefs(html).some((h) => h.startsWith('/services/deals/'))).toBe(false);
  });

  it('marks the count a floor, and does not jump to one deal, when more deals are unloaded', () => {
    mocks.deals = [deal(7)];
    mocks.hasNextPage = true;
    const html = render();
    expect(html).toContain('Open deal (1+)');
    expect(hrefs(html)).not.toContain('/services/deals/7');
  });

  it('still offers the list when unloaded deals may be on this service', () => {
    mocks.deals = [deal(8, 99)];
    mocks.hasNextPage = true;
    const html = render();
    expect(html).toContain('Open deals');
    expect(html).not.toContain('Open deal (');
  });

  it('does not jump to one deal when mature deals are left out on this domain', () => {
    mocks.deals = [deal(7)];
    mocks.hiddenOffDomain = 1;
    const html = render();
    expect(html).toContain('Open deal (1+)');
    expect(hrefs(html)).not.toContain('/services/deals/7');
  });

  it("shows a visitor Request, not Manage, and never loads the seller's deals for them", () => {
    mocks.viewerId = 1;
    mocks.deals = [deal(7)];
    const html = render();
    expect(html).toContain('Request');
    expect(html).not.toContain('Manage');
    expect(html).not.toContain('Open deal');
    expect(mocks.dealsEnabled.every((e) => !e)).toBe(true);
  });
});
