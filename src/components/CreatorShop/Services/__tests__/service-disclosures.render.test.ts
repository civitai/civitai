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
// The Buzz balance behind the real button needs a signed-in session; these tests are about what it sends.
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: (props: {
    label: string;
    disabled?: boolean;
    onPerformTransaction: () => void;
  }) =>
    createElement(
      'button',
      { disabled: props.disabled, onClick: () => props.onPerformTransaction() },
      props.label
    ),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: () => undefined }) }));
// The avatar reads the signed-in user; these tests are about the disclosure and what is sent.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => createElement('span', { 'data-avatar': true }),
}));
vi.mock('~/components/Currency/CurrencyBadge', () => ({
  CurrencyBadge: () => null,
}));

const { FeatureFlagsProvider } = await import('~/providers/FeatureFlagsProvider');
const { ServiceRequestModal, ServiceOfferingTerms, ServiceBuyerDisclosure } = await import(
  '~/components/CreatorShop/Services/deals/ServiceRequestModal'
);
const { PublishServiceModal } = await import('~/components/CreatorShop/Services/SellerAffirmation');

// Flags {} is a viewer outside every rollout, creatorServicesNext included.
const html = (component: ReactNode, flags: object = {}) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(FeatureFlagsProvider, { flags: flags as never } as never, component)
    )
  );

const escaped = (text: string) => text.replace(/'/g, '&#x27;');

describe('buyer disclosure in the request modal', () => {
  const offering = { id: 9, title: 'Badge', price: 2500, deliveryDays: 4, revisionsIncluded: 1 };
  const out = html(
    createElement(ServiceRequestModal, { offering, sellerUsername: 'seller' } as never)
  );

  it("shows the offering's own price, revisions and days, and the deal-code hours", () => {
    expect(out).toContain('2,500 Buzz is held now.');
    expect(out).toContain('Delivery within 4 days of acceptance.');
    expect(out).toContain('1 revision included.');
    expect(out).toContain('doesn&#x27;t accept within 48 hours');
    expect(out).toContain('it completes 72 hours after the latest delivery');
    expect(out).toContain('You have 48 hours after completion to dispute.');
    expect(out).toContain(escaped("Civitai isn't a party to this deal."));
  });

  // Empty flags: a buyer outside the creatorServicesNext rollout, so no review sentence.
  it('shows the dispute line without the review sentence outside the rollout', () => {
    expect(out).toContain('Then the seller is paid. Moderator decisions on disputes');
    expect(out).not.toContain('review the work as Happy');
  });

  it('adds the review sentence inside the rollout', () => {
    const inRollout = html(
      createElement(ServiceRequestModal, { offering, sellerUsername: 'seller' } as never),
      { creatorServicesNext: true }
    );
    expect(inRollout).toContain(
      'If you review the work as Happy, the seller is paid right away and you can no longer dispute.'
    );
  });

  it('puts the disclosure before the button that holds the Buzz', () => {
    const button = out.indexOf('Hold 2,500 Buzz and send request');
    expect(button).toBeGreaterThan(-1);
    expect(out.indexOf('Before you request:')).toBeLessThan(button);
    expect(out.indexOf('is held now')).toBeLessThan(button);
  });
});

describe('the request modal outside the creatorServicesNext rollout', () => {
  const offering = {
    id: 9,
    title: 'Badge',
    description: 'A hand-drawn badge.',
    price: 2500,
    deliveryDays: 4,
    revisionsIncluded: 1,
  };
  const terms = (flags: object) =>
    html(
      createElement(ServiceOfferingTerms, { offering, sellerUsername: 'seller' } as never),
      flags
    );
  const disclosure = (flags: object) =>
    html(createElement(ServiceBuyerDisclosure, { offering } as never), flags);

  it('keeps the plain seller line and the description, with no avatar or About heading', () => {
    const off = terms({});
    expect(off).toContain('From seller · ');
    expect(off).toContain('A hand-drawn badge.');
    expect(off).not.toContain('data-avatar');
    expect(off).not.toContain('About this service');
    // Control: inside the rollout the same component does show them, so the checks above can fail.
    const on = terms({ creatorServicesNext: true });
    expect(on).toContain('data-avatar');
    expect(on).toContain('About this service');
    expect(on).not.toContain('From seller · ');
  });

  it('keeps the bullet list without icons, with the same items as inside the rollout', () => {
    const off = disclosure({});
    const on = disclosure({ creatorServicesNext: true });
    expect(off).toContain('mantine-List-root');
    expect(off).not.toContain('mantine-ThemeIcon-root');
    expect(on).toContain('mantine-ThemeIcon-root');
    expect(on).not.toContain('mantine-List-root');
    for (const line of [
      '2,500 Buzz is held now.',
      'Delivery within 4 days of acceptance.',
      'Accept or request an included revision.',
      'Either side can ask to cancel before completion.',
      'You have 48 hours after completion to dispute.',
      escaped("Civitai isn't a party to this deal."),
    ]) {
      expect(off).toContain(line);
      expect(on).toContain(line);
    }
  });
});

describe('license in the request modal', () => {
  const base = { id: 9, title: 'Badge', price: 2500, deliveryDays: 4, revisionsIncluded: 1 };
  // Empty flags: a buyer outside the creatorServicesNext rollout.
  const render = (license: object) =>
    html(
      createElement(ServiceRequestModal, {
        offering: { ...base, ...license },
        sellerUsername: 'seller',
      } as never)
    );

  it("shows a licensed offering's terms and the agree box to a buyer outside the rollout", () => {
    const out = render({
      licensePreset: 'CommercialCredit',
      licenseCustomText: null,
      licenseAllowResale: false,
    });
    expect(out).toContain('License: Commercial, credit required');
    expect(out).toContain(
      'Credit the seller when you publish the files or a model built from them.'
    );
    expect(out).toContain(
      'The seller keeps copyright. This is a license to use the work, not a transfer.'
    );
    expect(out).toContain(
      escaped("These are the seller's license terms, between you and the seller.")
    );
    expect(out).toContain(escaped("I agree to the seller's license terms above."));
  });

  it("shows a Custom license's own text as written", () => {
    const out = render({
      licensePreset: 'Custom',
      licenseCustomText: 'Print runs under 500 only.',
      licenseAllowResale: true,
    });
    expect(out).toContain('License: Custom');
    expect(out).toContain('Print runs under 500 only.');
    // The seller's own text governs resale; a toggle line could contradict it.
    expect(out).not.toContain('May re-share or resell the files');
  });

  it('shows no license block for an offering without one, outside the rollout', () => {
    const out = render({ licensePreset: null, licenseCustomText: null, licenseAllowResale: false });
    expect(out).not.toContain('License:');
    expect(out).not.toContain('No license terms set');
    expect(out).not.toContain('I agree to the seller');
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
