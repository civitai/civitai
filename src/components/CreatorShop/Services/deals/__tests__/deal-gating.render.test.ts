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
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorServices: true }),
}));
// Stands in for the button so the test can read which offering it would report.
vi.mock('~/components/CreatorShop/Services/ReportServiceButton', () => ({
  ReportServiceButton: ({ offeringId }: { offeringId: number }) =>
    createElement('span', { 'data-report-offering': offeringId }, 'Report'),
}));

const { ServiceDealPage } = await import('~/components/CreatorShop/Services/deals/ServiceDealPage');
const { ServiceDealsList } = await import(
  '~/components/CreatorShop/Services/deals/ServiceDealsList'
);

const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MantineProvider, null, node));

const deal = (maxNsfwLevel: number, viewerRole = 'buyer') => ({
  id: 7,
  maxNsfwLevel,
  status: 'InProgress',
  viewerRole,
  seller: { username: 'seller' },
  buyer: { username: 'buyer' },
  offering: { id: 42, title: 'Portrait commission' },
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
  it('renders nothing of the deal outside <Gated>, so a mature deal on green redirects', () => {
    mocks.deal = deal(8);
    const html = render(createElement(ServiceDealPage, { dealId: 7 }));
    const gate = html.match(/<section data-gate="(\d+)">[\s\S]*<\/section>/);
    expect(gate?.[1]).toBe('8');
    // The redirect hides only what is inside the gate: every field the fixture carries must be in it.
    const outside = html.replace(gate?.[0] ?? '', '');
    for (const field of ['Portrait commission', 'please', 'seller', 'Deal #7'])
      expect({
        field,
        inside: gate?.[0].includes(field),
        outside: outside.includes(field),
      }).toEqual({
        field,
        inside: true,
        outside: false,
      });
  });

  it('labels a mature deal with its rating and a PG-13 one with nothing', () => {
    mocks.deal = deal(8);
    expect(render(createElement(ServiceDealPage, { dealId: 7 }))).toMatch(/>X<\/span>/);
    mocks.deal = deal(2);
    expect(render(createElement(ServiceDealPage, { dealId: 7 }))).not.toMatch(/>PG-13<\/span>/);
  });
});

describe('deal page: reporting the service', () => {
  it('lets the buyer report the service, and not the seller or a moderator', () => {
    // The offering's id (42), never the deal's (7).
    const report = /<section data-gate="2">[\s\S]*data-report-offering="42"[\s\S]*<\/section>/;
    mocks.deal = deal(2, 'buyer');
    expect(render(createElement(ServiceDealPage, { dealId: 7 }))).toMatch(report);
    for (const role of ['seller', 'moderator']) {
      mocks.deal = deal(2, role);
      expect(render(createElement(ServiceDealPage, { dealId: 7 }))).not.toContain(
        'data-report-offering'
      );
    }
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
