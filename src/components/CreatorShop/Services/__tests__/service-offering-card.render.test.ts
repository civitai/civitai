import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({ current: null as null | { id: number } }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingMenu', () => ({
  ServiceOfferingMenu: () => null,
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) =>
    createElement('span', { 'data-seller': true }, user.username),
}));

const ServiceOfferingCardModule = await import(
  '~/components/CreatorShop/Services/ServiceOfferingCard'
);
const { ServiceOfferingCard } = ServiceOfferingCardModule;

const offering = {
  id: 3,
  description: 'One portrait.',
  title: 'Portrait commission',
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  maxNsfwLevel: 1,
};

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ServiceOfferingCard, {
        offering,
        sellerId: 1,
        sellerUsername: 'mei',
        ...props,
      } as never)
    )
  );

describe('ServiceOfferingCard', () => {
  it('fills a coverless offering with a "No cover yet" tile that still carries price and slots', () => {
    const html = render({ slotsOpen: 2 });
    expect(html).toContain('No cover yet');
    expect(html).toContain('500');
    expect(html).toContain('2 slots open');
  });

  it('shows the seller only when one is passed', () => {
    expect(render({ seller: { id: 1, username: 'mei' } })).toContain('data-seller');
    expect(render()).not.toContain('data-seller');
  });

  it('offers a visitor Request, disabled when fully booked, and not at all when requests are closed', () => {
    expect(render()).toContain('Request');
    expect(render({ slotsOpen: 0 })).toMatch(/<button[^>]*disabled[^>]*>.*Request/s);
    expect(render({ canRequest: false })).not.toContain('Request');
  });

  it('offers the seller Manage on their own card instead of Request', () => {
    viewer.current = { id: 7 };
    const html = render({ sellerId: 7, sellerUsername: 'mei' });
    viewer.current = null;
    expect(html).toContain('href="/user/mei/shop/manage?tab=services"');
    expect(html).not.toContain('Request');
  });
});

describe('coverShowsLevelChip', () => {
  const { coverShowsLevelChip } = ServiceOfferingCardModule;
  it('is true while blurred, and on a revealed cover only for a moderator or the cover owner', () => {
    expect(coverShowsLevelChip({ safe: false })).toBe(true);
    expect(coverShowsLevelChip({ safe: true })).toBe(false);
    expect(coverShowsLevelChip({ safe: true, isModerator: true })).toBe(true);
    expect(coverShowsLevelChip({ safe: true, viewerId: 5, coverUserId: 5 })).toBe(true);
    expect(coverShowsLevelChip({ safe: true, viewerId: 5, coverUserId: 6 })).toBe(false);
    expect(coverShowsLevelChip({ safe: true, coverUserId: 6 })).toBe(false);
  });
});
