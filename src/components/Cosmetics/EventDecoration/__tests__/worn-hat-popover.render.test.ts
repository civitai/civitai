// @vitest-environment happy-dom
import type { MantineThemeOverride } from '@mantine/core';
import { MantineProvider, Modal } from '@mantine/core';
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
const { wornHat, viewer, myHats, dialogs, notify } = vi.hoisted(() => ({
  wornHat: {
    result: { data: undefined, isLoading: false, isError: false } as WornHatQuery,
    useQuery: vi.fn(),
  },
  viewer: { current: undefined as { id: number } | undefined },
  // Stable spies: the proxy's own useUtils mints a fresh one per read.
  myHats: { fetch: vi.fn() },
  dialogs: { trigger: vi.fn() },
  notify: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    { 'event.getWornHat': { useQuery: wornHat.useQuery } },
    { useUtils: () => ({ event: { getMyHats: myHats } }) }
  ),
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dialogStore: dialogs,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showErrorNotification: notify,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
// The live points subscription needs the app's SignalProvider; record what the popover mounts.
const livePoints = vi.hoisted(() => vi.fn());
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  WornHatLivePoints: (props: unknown) => {
    livePoints(props);
    return null;
  },
}));
// Formats as the real one does (Intl compact, so 1.2K), without its digit columns.
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value, abbreviate = true }: { value: number; abbreviate?: boolean }) =>
    React.createElement(
      'span',
      null,
      new Intl.NumberFormat(
        'en-US',
        abbreviate ? { notation: 'compact', maximumFractionDigits: 1 } : {}
      ).format(value)
    ),
}));
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
  topicId: 'a1b2c3d4e5f60718',
  points: 1234,
  impressions: 56789,
  reactions: 12,
};

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const outerClick = vi.fn();
const outerKeyDown = vi.fn();
beforeEach(() => {
  wornHat.useQuery.mockReset().mockImplementation(() => wornHat.result);
  wornHat.result = { data: WORN, isLoading: false, isError: false };
  viewer.current = undefined;
  outerClick.mockReset();
  outerKeyDown.mockReset();
  myHats.fetch.mockReset();
  dialogs.trigger.mockReset();
  notify.mockReset();
  livePoints.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

function render(
  element: React.ReactElement,
  { theme, env = 'test' }: { theme?: MantineThemeOverride; env?: 'test' | 'default' } = {}
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        // No transitions, so the dropdown is there as soon as it opens.
        { env, theme },
        // Anything above the card that listens for clicks, like a feed's row handler.
        React.createElement('div', { onClick: outerClick, onKeyDown: outerKeyDown }, element)
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
const moveButton = () =>
  [...popover()!.querySelectorAll('button')].find((b) => b.textContent === 'Move');
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
    // No eyebrow naming the event: the button below already does (Justin, 2026-10-09).
    expect(dropdown.textContent).not.toContain('Team hat');
    expect(dropdown.textContent).toMatch(/^Party Cap/);
    expect(dropdown.textContent).toContain('Party Cap');
    expect(dropdown.textContent).toContain('Worn by');
    expect(dropdown.querySelector('[data-testid="wearer"]')?.textContent).toBe('civbot');
    expect(dropdown.textContent).toContain('1.2K');
    expect(dropdown.textContent).toContain('56.8k');
    expect(dropdown.textContent).toContain("Scores for Team Blue while it's worn");
    // Totals are per hat, so a moved hat's figures include what it earned on earlier content.
    expect(dropdown.querySelector('[data-testid="hat-stats-scope"]')?.textContent).toBe(
      "This hat's totals from everywhere it has been worn"
    );
    const link = [...dropdown.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See the birthday event')
    );
    expect(link?.getAttribute('href')).toBe('/events/birthday2026');
  });

  // A feed of hatted cards must not listen for every hat: only an open popover follows its total.
  it('follows the hat total live only while the popover is open', () => {
    renderCard();
    expect(livePoints.mock.calls).toEqual([]);
    clickHat();
    expect(livePoints.mock.calls.at(-1)![0]).toEqual({
      event: 'birthday2026',
      entityType: 'Image',
      entityId: 5,
      topicId: 'a1b2c3d4e5f60718',
    });
  });

  it('keeps the confetti, and the click never reaches the card or anything above it', () => {
    renderCard();
    clickHat();
    expect(document.querySelector('[aria-hidden] span span')).not.toBeNull();
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('closes again on a second click', () => {
    renderCard();
    clickHat();
    clickHat();
    expect(enabledFlags().at(-1)).toBe(false);
  });

  it('closes on a click elsewhere on the page', () => {
    renderCard();
    clickHat();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  // A click leaves focus on the hat, outside the dropdown that handles Escape itself.
  it('closes on Escape pressed on the hat that opened it', () => {
    renderCard();
    hatButton().focus();
    clickHat();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      hatButton().dispatchEvent(escape);
    });
    expect(popover()).toBeNull();
    expect(enabledFlags().at(-1)).toBe(false);
    // Nothing around the card also takes this Escape: not a React handler above it, and not a
    // Mantine Modal, which skips a key from an element marked to stop it.
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  // A real Modal: it closes on Escape from a window listener that runs before any element's.
  it('closes only the popover, then the Modal it sits in, on two Escapes', () => {
    const closeModal = vi.fn();
    render(
      React.createElement(
        Modal,
        { opened: true, onClose: closeModal, title: 'Picker' },
        React.createElement(
          FeedCard,
          {
            href: '/images/5',
            eventDecoration: HAT,
            eventDecorationOn: { entityType: 'Image', entityId: 5 },
          } as React.ComponentProps<typeof FeedCard>,
          React.createElement('span', null, 'card body')
        )
      )
    );
    clickHat();
    const escape = () =>
      act(() => {
        hatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    escape();
    expect(popover()).toBeNull();
    expect(closeModal).not.toHaveBeenCalled();
    escape();
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it("calls someone else's hat theirs, for a signed-in viewer too", () => {
    viewer.current = { id: 1 };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('Worn by');
    expect(popover()!.textContent).not.toContain('Your hat');
    expect(moveButton()).toBeUndefined();
    expect(popover()!.textContent).not.toMatch(/\bMove\b/);
  });

  it("calls the viewer's own hat theirs and offers to move it", () => {
    viewer.current = { id: 9 };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('Your hat');
    expect(moveButton()).toBeDefined();
    expect(popover()!.textContent).not.toContain('Worn by');
  });

  it('moves the viewer’s own hat with the place-a-hat picker', async () => {
    viewer.current = { id: 9 };
    const here = { cosmeticId: 31, claimKey: 'c', placedOn: { entityType: 'Image', entityId: 5 } };
    // Decoys ahead of it: the same id on another type, another image, another hat on this image.
    const elsewhere = [
      { cosmeticId: 31, claimKey: 'd', placedOn: { entityType: 'Model', entityId: 5 } },
      { cosmeticId: 31, claimKey: 'e', placedOn: { entityType: 'Image', entityId: 6 } },
      { cosmeticId: 32, claimKey: 'f', placedOn: { entityType: 'Image', entityId: 5 } },
    ];
    myHats.fetch.mockResolvedValue([...elsewhere, here]);
    renderCard();
    clickHat();
    await act(async () => {
      moveButton()!.click();
    });
    expect(myHats.fetch).toHaveBeenCalledWith({ event: 'birthday2026' });
    expect(dialogs.trigger).toHaveBeenCalledTimes(1);
    expect(dialogs.trigger.mock.calls[0][0].props).toEqual({
      event: 'birthday2026',
      hat: here,
      myHats: [...elsewhere, here],
    });
  });

  it('keeps a click inside the popover from reaching anything above the card', () => {
    renderCard();
    clickHat();
    act(() => popover()!.querySelector<HTMLElement>('p')!.click());
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('keeps the card link from following the click', () => {
    renderCard();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      hatButton().dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
  });

  it('keeps the popover open, and the key moving, for any other key on the hat', () => {
    renderCard();
    clickHat();
    for (const key of ['Enter', ' ', 'Tab', 'a'])
      act(() => {
        hatButton().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    expect(popover()).not.toBeNull();
    expect(outerKeyDown).toHaveBeenCalledTimes(4);
  });

  it('leaves Escape alone while closed', () => {
    renderCard();
    hatButton().focus();
    act(() => {
      hatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape inside the popover', () => {
    renderCard();
    clickHat();
    act(() => {
      popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  it('closes when the event link is followed', () => {
    renderCard();
    clickHat();
    const link = [...popover()!.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('See the birthday event')
    )!;
    // happy-dom would navigate; only the close is under test.
    link.addEventListener('click', (e) => e.preventDefault());
    act(() => link.click());
    expect(popover()).toBeNull();
  });

  it('shows the stats without a wearer when the wearer is gone', () => {
    wornHat.result = { data: { ...WORN, owner: null }, isLoading: false, isError: false };
    viewer.current = { id: 9 };
    renderCard();
    clickHat();
    expect(popover()!.textContent).not.toContain('Worn by');
    expect(popover()!.textContent).not.toContain('Your hat');
    expect(popover()!.textContent).toContain('1.2K');
  });

  it('shows the hat and its wearer but no stats when the server cannot tell which copy it is', () => {
    wornHat.result = { data: { ...WORN, topicId: null }, isLoading: false, isError: false };
    renderCard();
    clickHat();
    expect(popover()!.querySelector('[data-testid="hat-stats"]')).toBeNull();
    expect(popover()!.querySelector('[data-testid="wearer"]')?.textContent).toBe('civbot');
  });

  it('shows a dash for comments and remixes until the server counts them', () => {
    const figures = () =>
      [...popover()!.querySelectorAll<HTMLElement>('[data-way]')].map(
        (w) => w.children[0].textContent
      );
    renderCard();
    clickHat();
    expect(figures().slice(2)).toEqual(['–', '–']);
    act(() => root?.unmount());
    wornHat.result = {
      data: { ...WORN, comments: 3, remixes: 0 },
      isLoading: false,
      isError: false,
    };
    renderCard();
    clickHat();
    expect(figures().slice(2)).toEqual(['3', '0']);
  });

  it('says so instead when the viewer’s hat is no longer here', async () => {
    viewer.current = { id: 9 };
    myHats.fetch.mockResolvedValue([
      { cosmeticId: 31, claimKey: 'd', placedOn: { entityType: 'Image', entityId: 6 } },
    ]);
    renderCard();
    clickHat();
    await act(async () => {
      moveButton()!.click();
    });
    expect(dialogs.trigger).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('still links to the event when the stats fail', () => {
    wornHat.result = { data: undefined, isLoading: false, isError: true };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('Stats unavailable');
    expect(popover()!.textContent).toContain('See the birthday event');
  });

  it('says there is nothing to show when the hat is not there now', () => {
    wornHat.result = { data: null, isLoading: false, isError: false };
    renderCard();
    clickHat();
    expect(popover()!.textContent).toContain('No stats to show here.');
    expect(popover()!.textContent).not.toContain('Stats unavailable');
  });

  it('shows a skeleton while the stats load', () => {
    wornHat.result = { data: undefined, isLoading: true, isError: false };
    renderCard();
    clickHat();
    expect(popover()!.querySelector('.mantine-Skeleton-root')).not.toBeNull();
    expect(popover()!.textContent).not.toContain('No stats to show here.');
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

// The app theme sets Popover to render in place, and `env: 'test'` renders every Popover in place
// too, so the rest of this file cannot see a dropdown that a clipping parent crops: the home block
// is `overflow: hidden` and cut the popover at its edge.
describe('under the app theme, outside the test env', () => {
  // Outside the test env the dropdown mounts and unmounts through a transition; fake its clock.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const wait = () => act(() => vi.advanceTimersByTimeAsync(400));

  it('draws the popover outside a clipping parent', async () => {
    const { theme } = await import('~/providers/ThemeProvider');
    render(
      React.createElement(
        'div',
        { 'data-testid': 'clip', style: { overflow: 'hidden' } },
        React.createElement(
          FeedCard,
          {
            href: '/images/5',
            eventDecoration: HAT,
            eventDecorationOn: { entityType: 'Image', entityId: 5 },
          } as React.ComponentProps<typeof FeedCard>,
          React.createElement('span', null, 'card body')
        )
      ),
      { theme, env: 'default' }
    );
    clickHat();
    await wait();
    expect(popover()).not.toBeNull();
    expect(document.querySelector('[data-testid="clip"]')!.contains(popover())).toBe(false);
  });

  // The popover now sits outside the Modal's DOM, so the Escape arms above need this one to hold.
  it('still closes only the popover, then the Modal it hangs from, on two Escapes', async () => {
    const closeModal = vi.fn();
    const { theme } = await import('~/providers/ThemeProvider');
    render(
      React.createElement(
        Modal,
        { opened: true, onClose: closeModal, title: 'Picker' },
        React.createElement(
          FeedCard,
          {
            href: '/images/5',
            eventDecoration: HAT,
            eventDecorationOn: { entityType: 'Image', entityId: 5 },
          } as React.ComponentProps<typeof FeedCard>,
          React.createElement('span', null, 'card body')
        )
      ),
      { theme, env: 'default' }
    );
    await wait();
    clickHat();
    await wait();
    expect(popover()).not.toBeNull();
    const escape = () =>
      act(() => {
        hatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    await escape();
    await wait();
    expect(popover()).toBeNull();
    expect(closeModal).not.toHaveBeenCalled();
    await escape();
    expect(closeModal).toHaveBeenCalledTimes(1);
  });
});
