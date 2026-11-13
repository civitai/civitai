import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) =>
    createElement('span', { 'data-seller': true }, user.username),
}));

const { ServiceOfferingCard } = await import(
  '~/components/CreatorShop/Services/ServiceOfferingCard'
);

const offering = {
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
      createElement(ServiceOfferingCard, { offering, ...props } as never)
    )
  );

describe('ServiceOfferingCard', () => {
  it('fills a coverless offering with a "No cover yet" tile that still carries price and slots', () => {
    const html = render({ slotsOpen: 2 });
    expect(html).toContain('No cover yet');
    expect(html).toContain('500');
    expect(html).toContain('2 slots open');
  });

  it('links View to the given href, and shows the seller only when one is passed', () => {
    const withSeller = render({
      href: '/user/mei/shop#service-7',
      seller: { id: 1, username: 'mei' },
    });
    expect(withSeller).toContain('href="/user/mei/shop#service-7"');
    expect(withSeller).toContain('data-seller');
    expect(render({ href: '/x' })).not.toContain('data-seller');
  });

  it('lets a caller replace the View button with its own actions', () => {
    const html = render({ href: '/x', footer: createElement('button', null, 'Request') });
    expect(html).toContain('Request');
    expect(html).not.toContain('>View<');
  });
});
