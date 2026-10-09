import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as SessionProvider from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import type * as DomainColor from '~/hooks/useDomainColor';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevel from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as HoverCard from '~/components/UserAvatar/UserHoverCard';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

const session = vi.hoisted(() => ({ autoplayGifs: true }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));
// The real BrowserSettingsProvider builds its store from these; effects never run in a static render.
vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionProvider>()),
  useCivitaiSessionContext: () => ({ type: 'authed', settings: { ...session } }),
}));
vi.mock('~/hooks/useDomainColor', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainColor>()),
  useDomainColor: () => 'green',
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevel>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof HoverCard>()),
  UserHoverCard: ({ children }: { children: ReactNode }) => children,
}));

const { BrowserSettingsProvider } = await import('~/providers/BrowserSettingsProvider');
const { Username } = await import('~/components/User/Username');
const { UserAvatarSimple } = await import('~/components/UserAvatar/UserAvatarSimple');
const { CosmeticSample } = await import('~/components/Shop/CosmeticSample');

const plate = {
  variant: 'gradient',
  gradient: { from: '#ffec99', to: '#fcc419', deg: 90 },
  animated: true,
};
const cosmetics = [
  { cosmetic: { type: 'NamePlate', data: plate }, data: null },
] as unknown as UserWithCosmetics['cosmetics'];

function render(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(BrowserSettingsProvider, null, node))
  );
}

describe('animated nameplates follow the viewer’s autoplay setting', () => {
  beforeEach(() => {
    session.autoplayGifs = true;
  });

  it('sweeps in Username with autoplay on, including the reduced-motion opt-out', () => {
    const html = render(createElement(Username, { username: 'ellie', cosmetics }));
    expect(html).toContain('animate-nameplate-sweep');
    expect(html).toContain('motion-reduce:animate-none');
  });

  it('holds still in Username when the viewer turned autoplay off', () => {
    session.autoplayGifs = false;
    const html = render(createElement(Username, { username: 'ellie', cosmetics }));
    expect(html).toContain('ellie');
    expect(html).not.toContain('animate-nameplate-sweep');
  });

  it('sweeps in UserAvatarSimple by default', () => {
    const html = render(createElement(UserAvatarSimple, { id: 1, username: 'ellie', cosmetics }));
    expect(html).toContain('animate-nameplate-sweep');
  });

  it('holds still in UserAvatarSimple when the card passes autoplayAnimations={false}', () => {
    const html = render(
      createElement(UserAvatarSimple, {
        id: 1,
        username: 'ellie',
        cosmetics,
        autoplayAnimations: false,
      })
    );
    expect(html).toContain('ellie');
    expect(html).not.toContain('animate-nameplate-sweep');
  });

  it('sweeps the shop sample without forwarding `animated` to the DOM', () => {
    const html = render(
      createElement(CosmeticSample, {
        cosmetic: { id: 1, name: 'Legend Nameplate', type: 'NamePlate', data: plate },
      })
    );
    expect(html).toContain('Sample Text');
    expect(html).toContain('animate-nameplate-sweep');
    expect(html).not.toContain('animated');
  });

  it('holds the shop sample still when the viewer turned autoplay off', () => {
    session.autoplayGifs = false;
    const html = render(
      createElement(CosmeticSample, {
        cosmetic: { id: 1, name: 'Legend Nameplate', type: 'NamePlate', data: plate },
      })
    );
    expect(html).not.toContain('animate-nameplate-sweep');
  });
});
