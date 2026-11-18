import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';

// A seller feared a buyer could take the previews and never pay: the held Buzz is now named on
// the seller's side, and only there.

const mocks = vi.hoisted(() => ({ deals: [] as Record<string, unknown>[] }));

vi.mock('~/components/Currency/CurrencyBadge', () => ({ CurrencyBadge: () => null }));
vi.mock('~/components/CreatorShop/Services/deals/deal.util', () => ({
  useMyServiceDeals: () => ({
    deals: mocks.deals,
    hiddenOffDomain: 0,
    isLoading: false,
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));
vi.mock('~/providers/AppProvider', () => ({ useServerDomains: () => ({ red: 'civitai.red' }) }));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

const { DealEscrowPanel } = await import('~/components/CreatorShop/Services/deals/DealEscrowPanel');
const { ServiceDealsList } = await import(
  '~/components/CreatorShop/Services/deals/ServiceDealsList'
);

const HELD_LINE = 'already held in escrow';
const deal = {
  id: 7,
  status: 'Accepted',
  held: true,
  settled: false,
  price: 5000,
  buzzType: 'yellow',
  offering: { title: 'Portrait' },
  counterparty: { username: 'someone' },
  nextDeadline: null,
  actions: [],
  primaryAction: null,
};
const html = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MantineProvider, null, node));

describe('the held Buzz line', () => {
  it('shows on the deal page for the seller, and the buyer keeps the escrow text', () => {
    const page = (viewerRole: string) =>
      html(createElement(DealEscrowPanel, { deal: { ...deal, viewerRole } as never }));
    expect(page('seller')).toContain(HELD_LINE);
    expect(page('buyer')).not.toContain(HELD_LINE);
    expect(page('buyer')).toContain('The Buzz is held, not paid.');
  });

  it("shows on the seller's request list, not the buyer's", () => {
    mocks.deals = [deal];
    const list = (role: 'buyer' | 'seller') =>
      html(createElement(ServiceDealsList, { role, emptyText: 'none' }));
    expect(list('seller')).toContain(HELD_LINE);
    expect(list('buyer')).not.toContain(HELD_LINE);
  });
});
