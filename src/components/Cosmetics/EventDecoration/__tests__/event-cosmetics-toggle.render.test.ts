// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * "Show event cosmetics" in the browsing menu: off hides worn event hats everywhere they are drawn
 * and all of Hat Turf, for this viewer only. Viewers complained they could not turn hats off.
 */

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = vi.hoisted(() => ({ showEventCosmetics: true }));
vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', () => ({
  useCivitaiSessionContext: () => ({
    type: 'unauthed',
    settings: {
      showNsfw: false,
      blurNsfw: true,
      browsingLevel: 1,
      disableHidden: true,
      allowAds: true,
      autoplayGifs: true,
      showEventCosmetics: session.showEventCosmetics,
    },
  }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: (props: { name?: string }) =>
    React.createElement('img', { 'data-name': props.name, alt: '' }),
  EdgeMedia2: () => null,
}));

const { BrowserSettingsProvider, EventCosmeticsPreview, useBrowsingSettings } = await import(
  '~/providers/BrowserSettingsProvider'
);
const { TwCosmeticWrapper } = await import('~/components/TwCosmeticWrapper/TwCosmeticWrapper');
const { AvatarHat } = await import('~/components/Cosmetics/EventDecoration/AvatarHat');
const { TurfSummaryProvider, useTurfFeed } = await import(
  '~/components/HatTurf/TurfSummaryProvider'
);

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.cookie = 'showEventCosmetics=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

const hat = { type: 'hat', event: 'birthday2026', url: 'u' } as const;
const frame = { cssFrame: 'linear-gradient(red, blue)' };
const showcaseHat = { url: 'h', until: new Date(Date.now() + 86_400_000).toISOString() };

let setShown: ((shown: boolean) => void) | undefined;
function Setter() {
  const setState = useBrowsingSettings((x) => x.setState);
  setShown = (shown) => setState({ showEventCosmetics: shown });
  return null;
}

let feed: unknown;
function FeedProbe() {
  feed = useTurfFeed();
  return null;
}

function render(shown: boolean, ...children: React.ReactNode[]) {
  session.showEventCosmetics = shown;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(BrowserSettingsProvider, null, React.createElement(Setter), ...children)
      )
    )
  );
}

// createElement with children as arguments: these components type `children` as a required prop,
// which the typed overloads read as missing.
const el = React.createElement as unknown as (
  type: unknown,
  props: object | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const card = () =>
  el(
    TwCosmeticWrapper,
    { cosmetic: frame, eventDecoration: hat, key: 'card' },
    el('div', { 'data-testid': 'card' })
  );
const cardHat = () => host!.querySelector('button[data-event-decoration="hat"]');
const avatarHat = () => host!.querySelector('img[data-name="showcase hat"]');

describe('show event cosmetics', () => {
  it('on: a card wears its hat and an avatar its showcase hat', () => {
    render(true, card(), React.createElement(AvatarHat, { hat: showcaseHat, size: 40, key: 'a' }));
    expect(cardHat()).not.toBeNull();
    expect(avatarHat()).not.toBeNull();
  });

  it('off: no hat on the card or the avatar, and the card keeps its frame', () => {
    render(false, card(), React.createElement(AvatarHat, { hat: showcaseHat, size: 40, key: 'a' }));
    expect(cardHat()).toBeNull();
    expect(avatarHat()).toBeNull();
    // Event cosmetics only: the frame, not an event cosmetic, still draws.
    const wrapper = host!.querySelector<HTMLElement>('[data-testid="card"]')!.parentElement!;
    expect(wrapper.style.getPropertyValue('--bgGradient')).toBe('linear-gradient(red, blue)');
    // No room is kept for the hidden hat.
    expect(wrapper.getAttribute('data-event-decoration')).toBeNull();
  });

  it('off: a preview of the hat being picked or bought still shows it', () => {
    render(false, el(EventCosmeticsPreview, { key: 'p' }, card()));
    expect(cardHat()).not.toBeNull();
  });

  it('off: no Hat Turf, as if the viewer were not playing', () => {
    render(
      true,
      el(
        TurfSummaryProvider,
        { imageIds: [1], gate: { event: 'birthday2026' }, key: 't' },
        el(FeedProbe, null)
      )
    );
    expect(feed).not.toBeNull();
    act(() => setShown!(false));
    expect(feed).toBeNull();
  });

  it('turning it off hides hats at once and keeps the choice in a cookie for this device', () => {
    render(true, card());
    expect(cardHat()).not.toBeNull();
    act(() => setShown!(false));
    expect(cardHat()).toBeNull();
    expect(document.cookie).toContain('showEventCosmetics=false');
  });
});
