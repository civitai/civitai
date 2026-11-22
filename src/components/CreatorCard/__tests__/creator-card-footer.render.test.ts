import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';
import type * as UsernameModule from '~/components/User/Username';

const mocks = vi.hoisted(() => ({
  links: [] as { url: string; domain: string }[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'user.getCreator': {
        useQuery: () => ({
          data: {
            id: 7,
            username: 'ellie',
            createdAt: null,
            rank: null,
            cosmetics: [],
            links: mocks.links,
            stats: {},
            publicSettings: {},
          },
        }),
      },
    }),
  };
});
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: () => null,
  UserProfileLink: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/User/Username', async (importOriginal) => ({
  ...(await importOriginal<typeof UsernameModule>()),
  Username: () => null,
  BadgeDisplay: () => null,
}));

const { IntersectionObserverProvider } = await import(
  '~/components/IntersectionObserver/IntersectionObserverProvider'
);
const { CreatorCardSimple } = await import('~/components/CreatorCard/CreatorCardSimple');

const render = (footer?: ReactNode) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        IntersectionObserverProvider,
        null,
        createElement(CreatorCardSimple, { user: { id: 7, username: 'ellie' }, footer })
      )
    )
  );

const sections = (html: string) => html.match(/mantine-Card-section/g)?.length ?? 0;

describe('creator card footer outlet', () => {
  it('draws the footer in its own divided section when given content', () => {
    const html = render(createElement('span', null, 'FOOTER-MARK'));
    expect(html).toContain('FOOTER-MARK');
    expect(sections(html)).toBe(2);
    expect(html.slice(html.lastIndexOf('<div', html.indexOf('FOOTER-MARK')))).toContain(
      'data-with-border'
    );
  });

  it('puts the footer after the links section when the creator has links', () => {
    mocks.links = [{ url: 'https://example.com/ellie', domain: 'example.com' }];
    const html = render(createElement('span', null, 'FOOTER-MARK'));
    mocks.links = [];
    expect(sections(html)).toBe(3);
    expect(html.indexOf('https://example.com/ellie')).toBeGreaterThan(-1);
    expect(html.indexOf('FOOTER-MARK')).toBeGreaterThan(html.indexOf('https://example.com/ellie'));
  });

  it('adds nothing without a footer', () => {
    const html = render();
    expect(sections(html)).toBe(1);
    expect(html).not.toContain('FOOTER-MARK');
  });
});
