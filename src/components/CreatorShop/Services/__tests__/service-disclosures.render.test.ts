import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type * as Mantine from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// Legal's copy, rendered from the offering and the deal constants, must reach the people it
// protects: the buyer before the hold, the seller before publishing.

vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Mantine>()),
  // A Modal renders through a portal, which static markup never reaches.
  Modal: ({ children, title }: { children: ReactNode; title: ReactNode }) =>
    createElement('div', null, createElement('h2', null, title), children),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorServiceDeal.request': {
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    },
    'creatorService.setStatus': {
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'yellow' }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('~/components/Currency/CurrencyBadge', () => ({
  CurrencyBadge: () => null,
}));

const { ServiceRequestModal } = await import(
  '~/components/CreatorShop/Services/deals/ServiceRequestModal'
);
const { PublishServiceModal } = await import('~/components/CreatorShop/Services/SellerAffirmation');

const html = (component: ReactNode) =>
  renderToStaticMarkup(createElement(MantineProvider, null, component));

const escaped = (text: string) => text.replace(/'/g, '&#x27;');

describe('buyer disclosure in the request modal', () => {
  const offering = { id: 9, title: 'Badge', price: 2500, deliveryDays: 4, revisionsIncluded: 1 };
  const out = html(
    createElement(ServiceRequestModal, { offering, sellerUsername: 'seller' } as never)
  );

  it("shows the offering's own price, revisions and days, and the deal-code hours", () => {
    expect(out).toContain('2,500 Buzz is held now');
    expect(out).toContain('Includes 1 revision. Delivery within 4 days of acceptance.');
    expect(out).toContain('doesn&#x27;t accept within 48 hours');
    expect(out).toContain('completes after 72 hours');
    expect(out).toContain('48-hour dispute window');
    expect(out).toContain(escaped("Civitai isn't a party to this deal."));
  });

  it('puts the disclosure before the button that holds the Buzz', () => {
    const button = out.indexOf('Hold 2,500 Buzz and send request');
    expect(button).toBeGreaterThan(-1);
    expect(out.indexOf('Before you request:')).toBeLessThan(button);
    expect(out.indexOf('is held now')).toBeLessThan(button);
  });
});

describe('seller confirmation before publishing', () => {
  const out = html(
    createElement(PublishServiceModal, {
      offering: { id: 3, title: 'Badge' },
    } as never)
  );

  it('shows the statement with Terms of Service linked, and Publish disabled until ticked', () => {
    expect(out).toContain('I confirm that:');
    expect(out).toContain(escaped("I'm responsible for any taxes on what I earn."));
    expect(out).toMatch(/<a[^>]*href="\/content\/tos"[^>]*>Terms of Service<\/a>/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Publish service/);
  });
});
