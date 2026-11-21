import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { SERVICE_DEAL_DISPUTE_WINDOW_MS } from '~/shared/constants/creator-services.constants';

// A buyer on an in-progress deal looked for a dispute button and found only the offering's
// report link: disputes open only after the delivery is accepted, and nothing said so.

const mocks = vi.hoisted(() => ({
  deal: null as Record<string, unknown> | null,
  flags: { creatorServices: true, creatorServicesNext: false },
}));

vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/CreatorShop/Services/deals/deal.util', () => ({
  useServiceDeal: () => ({
    deal: mocks.deal,
    isLoading: false,
    error: null,
    refetch: () => undefined,
  }),
  useServiceDealMutations: () => ({ review: { mutate: () => undefined, isPending: false } }),
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
vi.mock('~/components/CreatorShop/Services/deals/DealAttachmentsPanel', () => ({
  DealAttachmentsPanel: () => null,
}));
vi.mock('~/components/CreatorShop/Services/deals/DealFilesPanel', () => ({
  DealFilesPanel: () => null,
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: () => undefined }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
}));

const { ServiceDealPage } = await import('~/components/CreatorShop/Services/deals/ServiceDealPage');

const render = (status: string, viewerRole: string) => {
  mocks.deal = {
    id: 7,
    maxNsfwLevel: 1,
    status,
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
  };
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ServiceDealPage, { dealId: 7 }))
  );
};

const HINT = `you can open a dispute for ${
  SERVICE_DEAL_DISPUTE_WINDOW_MS / 3_600_000
} hours after you accept them`;

describe('deal page: when a dispute becomes available', () => {
  it.each(['Accepted', 'InRevision'])('tells the buyer on a %s deal', (status) => {
    expect(render(status, 'buyer')).toContain(HINT);
  });

  it.each([
    ['Accepted', 'seller'],
    ['Accepted', 'moderator'],
    ['Delivered', 'buyer'],
    ['Completed', 'buyer'],
    ['Requested', 'buyer'],
  ])('says nothing on a %s deal viewed as %s', (status, role) => {
    expect(render(status, role)).not.toContain(HINT);
  });

  it('labels the offering report link as a report on the service, not the order', () => {
    expect(render('Accepted', 'buyer')).toContain('Report this service');
  });
});

// The review card replaces the dispute window only for a deal enrolled in reviews, viewed with the
// review flag; with the flag off the page is today's.
describe('deal page: the review card', () => {
  const renderCompleted = ({ next, enrolled }: { next: boolean; enrolled: boolean }) => {
    mocks.flags = { creatorServices: true, creatorServicesNext: next };
    mocks.deal = {
      id: 7,
      maxNsfwLevel: 1,
      status: 'Completed',
      viewerRole: 'buyer',
      seller: { username: 'seller' },
      buyer: { username: 'buyer' },
      offering: { id: 42, title: 'Portrait commission' },
      requestedAt: new Date('2026-10-01T00:00:00Z'),
      deliveryDays: 7,
      revisionsUsed: 0,
      revisionsIncluded: 1,
      requestText: 'please',
      chatId: null,
      deadlines: { disputeUntil: new Date(Date.now() + 3_600_000) },
      actions: [],
      review: enrolled ? { settled: false, finalsClear: true, review: null } : null,
    };
    const page = renderToStaticMarkup(
      createElement(MantineProvider, null, createElement(ServiceDealPage, { dealId: 7 }))
    );
    mocks.flags = { creatorServices: true, creatorServicesNext: false };
    return page;
  };
  const DISPUTE_WINDOW = 'Dispute window closes in';
  const CARD = 'How did it turn out?';

  it('replaces the dispute window on an enrolled deal for a viewer with the flag', () => {
    const page = renderCompleted({ next: true, enrolled: true });
    expect(page).toContain(CARD);
    expect(page).toContain('Your review is public, with your username.');
    expect(page).not.toContain(DISPUTE_WINDOW);
  });

  it.each([
    ['flag off', { next: false, enrolled: true }],
    ['not enrolled', { next: true, enrolled: false }],
  ])('leaves the dispute window and no card with the %s', (_case, input) => {
    const page = renderCompleted(input);
    expect(page).toContain(DISPUTE_WINDOW);
    expect(page).not.toContain(CARD);
  });
});
