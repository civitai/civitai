import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// The SFW domain lists none of a seller's own mature offerings (getMine counts them instead);
// the panel must say where they went, or a seller thinks their service vanished.

const mocks = vi.hoisted(() => ({
  mine: { offerings: [] as unknown[], hiddenOffDomain: 0 },
}));

// `getMine` is mocked at the tRPC hook, so the real `useQueryMyServices` maps its response.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({ data: { canSell: true }, isLoading: false }),
    },
    'creatorService.getMine': {
      useQuery: () => ({
        data: { items: mocks.mine.offerings, hiddenOffDomain: mocks.mine.hiddenOffDomain },
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
  // Distinct hosts, so a link built from the wrong one cannot match.
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

const render = () =>
  renderToStaticMarkup(createElement(MantineProvider, null, createElement(ManageServicesPanel)));

const offering = (maxNsfwLevel: number) => ({
  id: 1,
  title: 'Portrait commission',
  status: 'Active',
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  maxOpenDeals: null,
  maxNsfwLevel,
});

const RED_LINK =
  /<a[^>]*href="\/\/civitai.red\/user\/seller\/shop\/manage"[^>]*>2 mature services: manage on civitai.red<\/a>/;

describe('manage services: own mature offerings off red', () => {
  beforeEach(() => {
    mocks.mine = { offerings: [], hiddenOffDomain: 0 };
  });

  it('links to this page on civitai.red, in place of the empty text, when every service is mature', () => {
    mocks.mine.hiddenOffDomain = 2;
    const html = render();
    expect(html).toMatch(RED_LINK);
    expect(html).not.toContain('No services yet');
  });

  it('shows the link below the services it can list', () => {
    mocks.mine = { offerings: [offering(NsfwLevel.PG13)], hiddenOffDomain: 2 };
    const html = render();
    expect(html).toMatch(RED_LINK);
    expect(html.indexOf('Portrait commission')).toBeLessThan(html.search(RED_LINK));
  });

  it('shows the empty text, and no link, when nothing is hidden', () => {
    const html = render();
    expect(html).toContain('No services yet');
    expect(html).not.toContain('civitai.red');
  });

  it('labels a listed mature service with its rating, a PG-13 one with nothing', () => {
    mocks.mine = { offerings: [offering(NsfwLevel.R)], hiddenOffDomain: 0 };
    expect(render()).toMatch(/>R<\/span>/);
    mocks.mine = { offerings: [offering(NsfwLevel.PG13)], hiddenOffDomain: 0 };
    expect(render()).not.toMatch(/>PG-13<\/span>/);
  });
});
