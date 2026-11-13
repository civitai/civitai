import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';
import type * as UsernameModule from '~/components/User/Username';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

let autoplayGifs = false;

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: () => null,
  UserProfileLink: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/User/Username', async (importOriginal) => ({
  ...(await importOriginal<typeof UsernameModule>()),
  Username: () => null,
  BadgeDisplay: () => null,
}));
vi.mock('~/providers/BrowserSettingsProvider', async () => ({
  useBrowsingSettings: (selector: (s: { autoplayGifs: boolean }) => unknown) =>
    selector({ autoplayGifs }),
}));
// EdgeVideo is where `options.anim` decides whether the video plays; expose it instead of a player.
vi.mock('~/components/EdgeMedia/EdgeVideo', () => ({
  EdgeVideo: ({ options }: { options: { anim?: boolean } }) =>
    createElement('video', { 'data-anim': String(options.anim) }),
}));

const { IntersectionObserverProvider } = await import(
  '~/components/IntersectionObserver/IntersectionObserverProvider'
);
const { CreatorCardSimple } = await import('~/components/CreatorCard/CreatorCardSimple');

const animatedBackground = [
  {
    cosmetic: {
      id: 862,
      name: 'bg',
      source: 'Shop',
      type: 'ProfileBackground',
      data: { url: 'abc-uuid', type: 'video' },
    },
    data: {},
  },
] as unknown as UserWithCosmetics['cosmetics'];

function backgroundAnim(setting: boolean) {
  autoplayGifs = setting;
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        IntersectionObserverProvider,
        null,
        createElement(CreatorCardSimple, {
          user: { id: 7, username: 'ellie', cosmetics: animatedBackground },
        })
      )
    )
  );
  return /<video[^>]*data-anim="(\w+)"/.exec(html)?.[1];
}

describe('creator card animated background', () => {
  it('stays a still when Autoplay GIFs is off', () => {
    expect(backgroundAnim(false)).toBe('false');
  });

  it('animates when Autoplay GIFs is on', () => {
    expect(backgroundAnim(true)).toBe('true');
  });
});
