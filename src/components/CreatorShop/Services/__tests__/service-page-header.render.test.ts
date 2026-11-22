import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

// The service page's title row carries Share and the options menu (which holds Report) for every
// viewer, the Request button is a plain button in the domain's Buzz color, and the seller's stats sit in the creator card.

const mocks = vi.hoisted(() => ({ viewerId: 1 as number | null }));

const offering = {
  id: 42,
  title: 'Portrait commission',
  description: 'One portrait.',
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  previewKind: 'None',
  licensePreset: null,
  maxNsfwLevel: 2,
  maxOpenDeals: null,
  slotsOpen: null,
  status: 'Active',
  coverImage: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  seller: { id: 9, username: 'seller' },
  record: { completed: 12, onTime: 9, offeringCompleted: 3 },
};

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorService.getById': { useQuery: () => ({ data: offering, isLoading: false }) },
  }),
}));
vi.mock('~/components/AppLayout/Page', () => ({ Page: (component: unknown) => component }));
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.viewerId == null ? null : { id: mocks.viewerId }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingMenu', () => ({
  ServiceOfferingMenu: ({
    offering: o,
    isOwner,
    placement,
  }: {
    offering: { id: number };
    isOwner: boolean;
    placement: string;
  }) =>
    createElement('span', {
      'data-menu-offering': o.id,
      'data-menu-owner': isOwner,
      'data-menu-placement': placement,
    }),
}));
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ children }: { children: ReactNode }) =>
    createElement('span', { 'data-share': true }, children),
}));
vi.mock('~/components/CreatorCard/CreatorCard', () => ({
  SmartCreatorCard: ({ footer }: { footer?: ReactNode }) =>
    createElement('aside', { 'data-creator-card': true }, footer),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/CreatorShop/Services/ServiceReviews', () => ({ ServiceReviews: () => null }));
vi.mock('~/components/CreatorShop/Services/deals/ServiceRequestModal', () => ({
  ServiceRequestModal: () => null,
  ServiceOfferingLicense: () => null,
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingCard', () => ({
  BlurCaption: () => null,
  COVER_ASPECT_RATIO: 1,
  NoCover: () => null,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: () => undefined } }));

const { default: ServicePage } = await import('~/pages/services/[id]/[[...slug]]');

const render = () =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServicePage as never, { id: offering.id } as never)
    )
  );

beforeEach(() => {
  mocks.viewerId = 1;
});

describe('service page title row', () => {
  it('holds Share and the options menu before the page body, for a visitor', () => {
    const html = render();
    const menu = html.indexOf('data-menu-offering="42"');
    expect(menu).toBeGreaterThan(-1);
    expect(html).toContain('data-menu-placement="title"');
    expect(html).toContain('data-menu-owner="false"');
    expect(html.indexOf('data-share')).toBeLessThan(html.indexOf('Request · 500 Buzz'));
    expect(menu).toBeLessThan(html.indexOf('Request · 500 Buzz'));
  });

  it('offers the menu signed out too, so Report stays reachable', () => {
    mocks.viewerId = null;
    expect(render()).toContain('data-menu-offering="42"');
  });

  it('has no separate Report button', () => {
    expect(render()).not.toContain('Report this service');
  });

  it('tells the menu the seller is the owner on their own page', () => {
    mocks.viewerId = 9;
    expect(render()).toContain('data-menu-owner="true"');
  });
});

describe('service page sidebar', () => {
  it('draws Request as a plain button in the domain color, not the funds-checking Buzz button', () => {
    const html = render();
    expect(html).toContain('>Request · 500 Buzz<');
    expect(html).toContain('--button-bg:var(--mantine-color-green-filled)');
  });

  it("shows the seller's deals and on-time share inside the creator card", () => {
    const html = render();
    const card = html.slice(html.indexOf('data-creator-card'));
    expect(card).toContain('12 deals · 75% on time');
  });

  it('no longer shows the escrow notice', () => {
    expect(render()).not.toContain('held in escrow');
  });

  it('left-aligns the price like the other details rows', () => {
    expect(render()).not.toContain('--group-justify:flex-end');
  });
});
