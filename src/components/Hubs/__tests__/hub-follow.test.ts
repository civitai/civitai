// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { followMutate, unfollowMutate, currentUser, followedHubs } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  unfollowMutate: vi.fn(),
  currentUser: { value: { id: 3 } as { id: number } | null },
  followedHubs: {
    value: [] as { id: number; key: string; name: string; sources: unknown[] }[],
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));

// Spread the real module and override only `trpc`: a wholesale factory replaces
// `~/utils/trpc` with a hand-written object, so the day it gains an export this
// factory omits, every importer in this file's graph gets `undefined` and the FILE
// fails to load — 0 tests collected, no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    useUtils: () => ({ userHub: { getFollowed: { invalidate: vi.fn() } } }),
    userHub: {
      getFollowed: { useQuery: () => ({ data: followedHubs.value, isLoading: false }) },
      follow: { useMutation: () => ({ mutate: followMutate, isPending: false }) },
      unfollow: { useMutation: () => ({ mutate: unfollowMutate, isPending: false }) },
    },
  },
}));

import type * as Trpc from '~/utils/trpc';
import { FollowHubButton } from '~/components/Hubs/FollowHubButton';
import { FollowedHubsSection } from '~/components/Hubs/FollowedHubsSection';

// No JSX on purpose: the `unit` project's include is `*.test.ts`, so a `.tsx` test
// file is collected by NOTHING and reports zero tests rather than failing.
function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(createElement(MantineProvider, null, element));
  });
  return container;
}

// MantineProvider injects a <style> element, whose CSS text is part of
// `container.textContent`. Asserting "rendered nothing" against the raw text
// therefore never passes — read the text the viewer would see.
function visibleText(container: HTMLElement) {
  return [...container.querySelectorAll('style')].reduce(
    (text, style) => text.replace(style.textContent ?? '', ''),
    container.textContent ?? ''
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  currentUser.value = { id: 3 };
  followedHubs.value = [];
});

describe('FollowedHubsSection', () => {
  it('renders nothing at all when the viewer follows none', () => {
    // Not an empty heading: the section is permanent chrome otherwise, for every
    // viewer who never follows anything.
    const container = render(createElement(FollowedHubsSection, {}));

    expect(visibleText(container)).toBe('');
  });

  it('lists each followed hub, linked by its encoded key and slug', () => {
    followedHubs.value = [
      { id: 5, key: 'Xk3p9aBc', name: 'Cute Models', sources: [{}] },
      { id: 6, key: 'Qm7r2dEf', name: 'Other', sources: [] },
    ];

    const container = render(createElement(FollowedHubsSection, {}));

    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toStrictEqual([
      '/hubs/Xk3p9aBc/cute-models',
      '/hubs/Qm7r2dEf/other',
    ]);
    // The ids are on the objects above, so a link built from `id` would read
    // `/hubs/5/...` and pass nothing here — which is the point of asserting the
    // whole href rather than that it contains the slug.
    for (const link of links) expect(link.getAttribute('href')).not.toMatch(/\/hubs\/\d/);
    expect(visibleText(container)).toContain('1 source');
    expect(visibleText(container)).toContain('No sources');
  });

  it('unfollows the row that was clicked, not the first one', () => {
    // The assertion that catches an id read off the wrong row: with one hub in the
    // list, `followed[0].id` and `hub.id` are the same number.
    followedHubs.value = [
      { id: 5, key: 'Xk3p9aBc', name: 'First', sources: [] },
      { id: 6, key: 'Qm7r2dEf', name: 'Second', sources: [] },
    ];

    const container = render(createElement(FollowedHubsSection, {}));
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Unfollow Second"]'
    );

    act(() => {
      button?.click();
    });

    expect(unfollowMutate).toHaveBeenCalledTimes(1);
    expect(unfollowMutate).toHaveBeenCalledWith({ key: 'Qm7r2dEf' });
  });

  it('keeps the unfollow control OUTSIDE the link', () => {
    // A button inside an anchor is invalid markup and the click navigates as well as
    // unfollowing — which is a bug you only see in a real browser.
    followedHubs.value = [{ id: 5, key: 'Xk3p9aBc', name: 'First', sources: [] }];

    const container = render(createElement(FollowedHubsSection, {}));

    expect(container.querySelector('a button')).toBeNull();
    expect(container.querySelector('button[aria-label="Unfollow First"]')).not.toBeNull();
  });

  it('reveals the control on hover and on keyboard focus', () => {
    // Hover alone makes it pointer-only. Asserted on the class list rather than on
    // computed style, because component tests load no stylesheet.
    followedHubs.value = [{ id: 5, key: 'Xk3p9aBc', name: 'First', sources: [] }];

    const container = render(createElement(FollowedHubsSection, {}));
    const button = container.querySelector('button[aria-label="Unfollow First"]');

    expect(button?.className).toContain('opacity-0');
    expect(button?.className).toContain('group-hover:opacity-100');
    expect(button?.className).toContain('focus:opacity-100');
    expect(button?.closest('.group')).not.toBeNull();
  });
});

describe('FollowHubButton', () => {
  it('renders nothing for the hub owner', () => {
    const container = render(
      createElement(FollowHubButton, { hub: { key: 'Xk3p9aBc', isOwner: true } })
    );

    expect(visibleText(container)).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing for a signed-out viewer', () => {
    currentUser.value = null;

    const container = render(
      createElement(FollowHubButton, { hub: { key: 'Xk3p9aBc', isOwner: false } })
    );

    expect(visibleText(container)).toBe('');
    expect(container.querySelector('button')).toBeNull();
  });

  it('follows a hub that is not in the list', () => {
    const container = render(
      createElement(FollowHubButton, { hub: { key: 'Xk3p9aBc', isOwner: false } })
    );

    expect(container.querySelector('button')?.textContent).toBe('Follow');
    act(() => {
      container.querySelector('button')?.click();
    });
    expect(followMutate).toHaveBeenCalledWith({ key: 'Xk3p9aBc' });
    expect(unfollowMutate).not.toHaveBeenCalled();
  });

  it('shows Following, and unfollows, for a hub already in the list', () => {
    followedHubs.value = [{ id: 5, key: 'Xk3p9aBc', name: 'First', sources: [] }];

    const container = render(
      createElement(FollowHubButton, { hub: { key: 'Xk3p9aBc', isOwner: false } })
    );

    expect(container.querySelector('button')?.textContent).toBe('Following');
    act(() => {
      container.querySelector('button')?.click();
    });
    expect(unfollowMutate).toHaveBeenCalledWith({ key: 'Xk3p9aBc' });
    expect(followMutate).not.toHaveBeenCalled();
  });
});
