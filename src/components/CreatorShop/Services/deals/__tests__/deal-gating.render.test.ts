import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `get` returns a mature deal on green on purpose: the page's <Gated> is the control that sends
// it to red. The rating field ships in the same PR, so this pins the wiring that makes it safe.

const mocks = vi.hoisted(() => ({
  deal: null as Record<string, unknown> | null,
  list: { deals: [] as unknown[], hiddenOffDomain: 0 },
}));

vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ contentNsfwLevel, children }: { contentNsfwLevel: number; children: ReactNode }) =>
    createElement('section', { 'data-gate': contentNsfwLevel }, children),
}));
vi.mock('~/components/CreatorShop/Services/deals/deal.util', () => ({
  useServiceDeal: () => ({ deal: mocks.deal, isLoading: false }),
  useMyServiceDeals: () => ({
    ...mocks.list,
    isLoading: false,
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));
vi.mock('~/components/Chat/ChatProvider', () => ({ useChatStore: { setState: () => undefined } }));
vi.mock('~/components/CreatorShop/Services/deals/DealAccountabilitySheet', () => ({
  DealAccountabilitySheet: () => null,
}));
vi.mock('~/components/CreatorShop/Services/deals/DealActionsPanel', () => ({
  DealActionsPanel: () => null,
}));
vi.mock('~/components/CreatorShop/Services/deals/DealEscrowPanel', () => ({
  DealEscrowPanel: () => null,
}));
vi.mock('~/components/CreatorShop/Services/deals/DealFilesPanel', () => ({
  DealFilesPanel: () => null,
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('~/providers/AppProvider', () => ({
  useServerDomains: () => ({ green: 'civitai.com', blue: 'civitai.red', red: 'civitai.red' }),
}));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));

const { ServiceDealPage } = await import('~/components/CreatorShop/Services/deals/ServiceDealPage');
const { ServiceDealsList } = await import(
  '~/components/CreatorShop/Services/deals/ServiceDealsList'
);

const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MantineProvider, null, node));

const deal = (maxNsfwLevel: number) => ({
  id: 7,
  maxNsfwLevel,
  status: 'InProgress',
  viewerRole: 'buyer',
  seller: { username: 'seller' },
  buyer: { username: 'buyer' },
  offering: { title: 'Portrait commission' },
  requestedAt: new Date('2026-10-01T00:00:00Z'),
  deliveryDays: 7,
  revisionsUsed: 0,
  revisionsIncluded: 1,
  requestText: 'please',
  chatId: null,
  deadlines: {},
  actions: [],
});

describe('deal page gate', () => {
  it('wraps the whole deal in <Gated> at the deal rating, so a mature deal on green redirects', () => {
    mocks.deal = deal(8);
    const html = render(createElement(ServiceDealPage, { dealId: 7 }));
    // The title must be inside the gate, or the redirect would leave the deal readable on green.
    expect(html).toMatch(/<section data-gate="8">[\s\S]*Portrait commission[\s\S]*<\/section>/);
  });

  it('labels a mature deal with its rating and a PG-13 one with nothing', () => {
    mocks.deal = deal(8);
    expect(render(createElement(ServiceDealPage, { dealId: 7 }))).toMatch(/>X<\/span>/);
    mocks.deal = deal(2);
    expect(render(createElement(ServiceDealPage, { dealId: 7 }))).not.toMatch(/>PG-13<\/span>/);
  });
});

describe('my deals: deals left out off red', () => {
  beforeEach(() => {
    mocks.list = { deals: [], hiddenOffDomain: 0 };
  });

  it('says how many deals are on civitai.red, in place of the empty text', () => {
    mocks.list.hiddenOffDomain = 2;
    const html = render(createElement(ServiceDealsList, { role: 'buyer', emptyText: 'None yet.' }));
    expect(html).toMatch(
      /<a[^>]*href="\/\/civitai.red\/services\/deals"[^>]*>2 deals on civitai.red<\/a>/
    );
    expect(html).not.toContain('None yet.');
  });

  it('shows the empty text when nothing is hidden', () => {
    const html = render(createElement(ServiceDealsList, { role: 'buyer', emptyText: 'None yet.' }));
    expect(html).toContain('None yet.');
    expect(html).not.toContain('civitai.red');
  });
});
