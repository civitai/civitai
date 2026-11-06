import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// A service went Active on a shop that was still a draft, and its seller had no hint buyers could
// not see it. The warning belongs on Active offerings only, and only while the shop is a draft.

const mocks = vi.hoisted(() => ({ offerings: [] as unknown[] }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({ data: { canSell: true }, isLoading: false }),
    },
    'creatorService.getMine': {
      useQuery: () => ({
        data: { items: mocks.offerings, hiddenOffDomain: 0 },
        isLoading: false,
      }),
    },
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceDealsList', () => ({
  ServiceDealsList: () => null,
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingFormModal', () => ({
  ServiceOfferingFormModal: () => null,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: () => undefined } }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));
vi.mock('~/providers/AppProvider', () => ({
  useServerDomains: () => ({ green: 'green.test', blue: 'blue.test', red: 'civitai.red' }),
}));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/user/seller/shop/manage' }) }));
vi.mock('~/components/Currency/CurrencyBadge', () => ({
  CurrencyBadge: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const { ManageServicesPanel } = await import(
  '~/components/CreatorShop/Services/ManageServicesPanel'
);

const WARNING = "Buyers can't see this until you publish your shop.";
const unpublished = { onPublish: () => undefined, publishing: false };

const render = (props: Parameters<typeof ManageServicesPanel>[0] = {}) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ManageServicesPanel, props))
  );

const offering = (id: number, title: string, status: string) => ({
  id,
  title,
  status,
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  maxOpenDeals: null,
  maxNsfwLevel: 2,
  termsAffirmed: true,
});

const escaped = (text: string) => text.replace(/'/g, '&#x27;');

describe('manage services: shop still a draft', () => {
  beforeEach(() => {
    mocks.offerings = [offering(1, 'Portrait commission', 'Active')];
  });

  it('warns on an Active offering, with the Publish shop action', () => {
    const html = render({ unpublishedShop: unpublished });
    expect(html).toContain(escaped(WARNING));
    expect(html).toContain('Publish shop');
  });

  it('says nothing once the shop is published', () => {
    const html = render();
    expect(html).not.toContain(escaped(WARNING));
    expect(html).not.toContain('Publish shop');
  });

  it('warns only on Active offerings, not a draft or paused one', () => {
    mocks.offerings = [
      offering(1, 'Active one', 'Active'),
      offering(2, 'Draft one', 'Draft'),
      offering(3, 'Paused one', 'Paused'),
    ];
    const html = render({ unpublishedShop: unpublished });
    expect(html.split(escaped(WARNING)).length - 1).toBe(1);
  });
});
