// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * A worn hat's popover reads its stats only once it is opened: a feed of hatted cards must cost no
 * request. Renders a real feed card (FeedCard -> CosmeticCard -> TwCosmeticWrapper ->
 * EventDecorationOverlay) and reads what the card asks of `event.getWornHat` before and after a
 * click on the hat.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WornHatQuery = { data: unknown; isLoading: boolean; isError: boolean };
const { wornHat, viewer } = vi.hoisted(() => ({
  wornHat: {
    result: { data: undefined, isLoading: false, isError: false } as WornHatQuery,
    useQuery: vi.fn(),
  },
  viewer: { current: undefined as { id: number } | undefined },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({ 'event.getWornHat': { useQuery: wornHat.useQuery } }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => null,
  EdgeMedia2: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) =>
    React.createElement('span', { 'data-testid': 'wearer' }, user.username),
}));

const { FeedCard } = await import('~/components/Cards/FeedCard');
const { EventDecorationOverlay } = await import(
  '~/components/Cosmetics/EventDecoration/EventDecorationOverlay'
);

const HAT = { type: 'hat', event: 'birthday2026', url: 'u', team: 'Blue' };
const WORN = {
  cosmeticId: 31,
  name: 'Party Cap',
  team: 'Blue',
  url: 'u',
  owner: { id: 9, username: 'civbot', image: null },
  points: 1234,
  impressions: 56789,
  reactions: 12,
};

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const outerClick = vi.fn();
beforeEach(() => {
  wornHat.useQuery.mockReset().mockImplementation(() => wornHat.result);
  wornHat.result = { data: WORN, isLoading: false, isError: false };
  viewer.current = undefined;
  outerClick.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        // No transitions, so the dropdown is there as soon as it opens.
        { env: 'test' },
        // Anything above the card that listens for clicks, like a feed's row handler.
        React.createElement('div', { onClick: outerClick }, element)
      )
    )
  );
}

const renderCard = () =>
  render(
    React.createElement(
      FeedCard,
      {
        href: '/images/5',
        eventDecoration: HAT,
        eventDecorationOn: { entityType: 'Image', entityId: 5 },
      } as React.ComponentProps<typeof FeedCard>,
      React.createElement('span', null, 'card body')
    )
  );

const hatButton = () =>
  document.querySelector<HTMLButtonElement>('button[data-event-decoration="hat"]')!;
const popover = () => document.querySelector<HTMLElement>('[data-testid="worn-hat-popover"]');
const clickHat = () => act(() => hatButton().click());
const enabledFlags = () =>
  wornHat.useQuery.mock.calls.map(([, opts]) => (opts as { enabled: boolean }).enabled);

describe('a hatted feed card', () => {
  it('asks for nothing until its hat is clicked', () => {
    renderCard();
    expect(wornHat.useQuery).toHaveBeenCalled();
    expect(enabledFlags().every((x) => x === false)).toBe(true);
    expect(popover()).toBeNull();
  });

  it('reads the hat on this content once clicked, and shows its stats and the event', () => {
    renderCard();
    clickHat();
    const [input, opts] = wornHat.useQuery.mock.calls.at(-1)!;
    expect(input).toEqual({ event: 'birthday2026', entityType: 'Image', entityId: 5 });
    expect(opts).toEqual({ enabled: true });

    const dropdown = popover()!;
    expect(dropdown.textContent).toContain('Civitai Birthday · Team hat');
    expect(dropdown.textContent).toContain('Party Cap');
    expect(dropdown.textContent).toContain('Worn by');
    expect(dropdown.querySelector('[data-testid="wearer"]')?.textContent).toBe('civbot');
    expect(dropdown.textContent).toContain('1.2k');
    expect(dropdown.textContent).toContain('56.8k');
    expect(dropdown.textContent).toContain("Scores for Team Blue while it's worn");
    const link = [...dropdown.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See the birthday event')
    );
    expect(link?.getAttribute('href')).toBe('/events/birthday2026');
  });

  it('keeps the confetti, and the click never reaches the card or anything above it', () => {
    renderCard();
    clickHat();
    expect(document.querySelector('[aria-hidden] span span')).not.toBeNull();
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('keeps a click inside the popover from reaching anything above the card', () => {
    renderCard();
    clickHat();
    act(() => popover()!.querySelector<HTMLElement>('p')!.click());
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('closes again on a second click', () => {
    renderCard();
    clickHat();
    clickHat();
    expect(enabledFlags().at(-1)).toBe(false);
  });

  it("calls the viewer's own hat theirs and offers to move it", () => {
    viewer.current = { id: 9 };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('Your hat');
    expect(popover()!.textContent).toContain('Move it');
    expect(popover()!.textContent).not.toContain('Worn by');
  });

  it('still links to the event when the stats fail', () => {
    wornHat.result = { data: undefined, isLoading: false, isError: true };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('Stats unavailable');
    expect(popover()!.textContent).toContain('See the birthday event');
  });

  it('says the hat has gone when the card outlived it', () => {
    wornHat.result = { data: null, isLoading: false, isError: false };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('This hat has moved on.');
    expect(popover()!.textContent).not.toContain('Stats unavailable');
    expect(popover()!.textContent).toContain('See the birthday event');
  });

  it('shows a skeleton while the stats load', () => {
    wornHat.result = { data: undefined, isLoading: true, isError: false };
    renderCard();
    clickHat();
    expect(popover()!.querySelector('.mantine-Skeleton-root')).not.toBeNull();
    expect(popover()!.textContent).not.toContain('Stats unavailable');
  });
});

// Positive control for the arms above: a hat with no content behind it (a preview, a try-on) has
// nothing to look up, so a click only bursts.
describe('a hat not worn on content', () => {
  it('only bursts', () => {
    render(React.createElement(EventDecorationOverlay, { decoration: HAT }));
    clickHat();
    expect(wornHat.useQuery).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    expect(document.querySelector('[aria-hidden] span span')).not.toBeNull();
  });
});
