import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type * as Mantine from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// The request popup's hold button is the site's Buzz button, in the domain's color, for viewers in
// the creatorServicesNext rollout; everyone else keeps the plain yellow button.

const mocks = vi.hoisted(() => ({
  next: true,
  domain: 'green' as 'green' | 'red' | 'blue',
}));

vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof Mantine>()),
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorServiceDeal.request': {
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => mocks.domain }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalFeatureFlags: () => ({ creatorServicesNext: mocks.next }),
  useFeatureFlags: () => ({ creatorServicesNext: mocks.next, isGreen: mocks.domain === 'green' }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('~/components/Currency/CurrencyBadge', () => ({ CurrencyBadge: () => null }));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: (p: {
    colorType: string;
    buzzAmount: number;
    label: string;
    'aria-label': string;
    performTransactionOnPurchase?: boolean;
  }) =>
    createElement(
      'button',
      {
        'data-buzz-button': p.colorType,
        'data-amount': p.buzzAmount,
        'data-purchase-places-hold': String(p.performTransactionOnPurchase ?? true),
        'aria-label': p['aria-label'],
      },
      p.label
    ),
}));

const { ServiceRequestModal } = await import(
  '~/components/CreatorShop/Services/deals/ServiceRequestModal'
);

const offering = { id: 9, title: 'Badge', price: 2500, deliveryDays: 4, revisionsIncluded: 1 };
const render = () =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServiceRequestModal, { offering, sellerUsername: 'seller' } as never)
    )
  );

beforeEach(() => {
  mocks.next = true;
  mocks.domain = 'green';
});

describe('request popup hold button', () => {
  it('is the Buzz button in green on the green domain, with the short label and the full text as its name', () => {
    const out = render();
    expect(out).toContain('data-buzz-button="green"');
    expect(out).toContain('data-amount="2500"');
    expect(out).toContain('>Hold and send request<');
    expect(out).toContain('aria-label="Hold 2,500 Buzz and send request"');
  });

  it('never places the hold on the back of a Buzz purchase', () => {
    expect(render()).toContain('data-purchase-places-hold="false"');
  });

  it('is the Buzz button in yellow on the red domain', () => {
    mocks.domain = 'red';
    expect(render()).toContain('data-buzz-button="yellow"');
  });

  it('stays the plain yellow button outside the rollout', () => {
    mocks.next = false;
    const out = render();
    expect(out).not.toContain('data-buzz-button');
    expect(out).toContain('Hold 2,500 Buzz and send request');
    expect(out).toContain('--button-bg:var(--mantine-color-yellow-filled)');
  });
});
