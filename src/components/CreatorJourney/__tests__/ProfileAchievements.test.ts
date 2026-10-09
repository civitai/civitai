// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({
  viewer: null as {
    id: number;
    username?: string;
    meta: { scores: { total: number } };
  } | null,
  shareable: undefined as boolean | undefined,
  shareQueries: [] as { input: unknown; enabled: boolean }[],
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.viewer,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorJourney.isMilestoneShareable': {
      useQuery: (input: unknown, { enabled }: { enabled: boolean }) => {
        mocks.shareQueries.push({ input, enabled });
        return { data: enabled ? mocks.shareable : undefined };
      },
    },
  }),
}));
// The site share popover needs the app's providers; what it is handed is what this file checks.
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ url, title, children }: { url: string; title: string; children: never }) =>
    React.createElement('span', { 'data-share-url': url, 'data-share-title': title }, children),
}));

import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as Trpc from '~/utils/trpc';
import {
  AchievementCard,
  ProfileTierCard,
  SECRET_ACHIEVEMENT_LABEL,
} from '~/components/CreatorJourney/ProfileAchievements';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = 7;
const EARNED = new Date('2026-09-28T12:00:00Z');

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(MantineProvider, null, element)));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.viewer = null;
  mocks.shareable = undefined;
  mocks.shareQueries = [];
});

describe('profile achievement cards', () => {
  // The server sends a visitor an earned secret with no name; the card must still say what it is.
  it('labels a secret achievement and shows nothing about it but the date', () => {
    const card = mount(
      React.createElement(AchievementCard, {
        achievement: {
          key: 'secret:0',
          track: 'secret',
          name: null,
          description: null,
          badgeUrl: null,
          achievedAt: EARNED,
        },
      })
    );
    expect(SECRET_ACHIEVEMENT_LABEL).toBe('Secret achievement');
    expect(card.textContent).toContain('Secret achievement');
    expect(card.textContent).not.toContain('Creator Score');
  });

  it('shows a named achievement with its description', () => {
    const card = mount(
      React.createElement(AchievementCard, {
        achievement: {
          key: 'create:models-25',
          track: 'create',
          name: '25 Models',
          description: 'Publish 25 models',
          badgeUrl: null,
          achievedAt: EARNED,
        },
      })
    );
    expect(card.textContent).toContain('25 Models');
    expect(card.textContent).toContain('Publish 25 models');
  });
});

describe('profile tier card', () => {
  const tier = { key: 'score:star', name: 'Star', badgeUrl: null, achievedAt: EARNED };
  const OWN_SCORE = 824228;

  it('shows the owner their own score', () => {
    mocks.viewer = { id: OWNER, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(card.textContent).toContain('Only you see this');
    expect(card.textContent).toContain('824,228');
  });

  // A signed-in visitor's session carries their own score, never the owner's; showing it here
  // would read as the owner's number.
  it('shows a visitor the tier and no score line', () => {
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(card.textContent).toContain('Star');
    expect(card.textContent).not.toContain('Only you see this');
    expect(card.textContent).not.toContain('824,228');
  });

  const shareLinks = (card: HTMLElement) =>
    [...card.querySelectorAll('[data-share-url]')].map((el) => ({
      url: el.getAttribute('data-share-url'),
      title: el.getAttribute('data-share-title'),
      label: el.querySelector('button')?.getAttribute('aria-label'),
    }));

  it('offers the owner a share link to the tier card when it renders', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: OWN_SCORE } } };
    mocks.shareable = true;
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(shareLinks(card)).toEqual([
      {
        url: '/user/maker?milestone=star',
        title: 'I reached Star on Civitai',
        label: 'Share Star',
      },
    ]);
    expect(mocks.shareQueries.at(-1)).toEqual({
      input: { userId: OWNER, slug: 'star' },
      enabled: true,
    });
  });

  it('offers no share link when the card would not render', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: OWN_SCORE } } };
    mocks.shareable = false;
    expect(
      shareLinks(mount(React.createElement(ProfileTierCard, { tier, userId: OWNER })))
    ).toEqual([]);
  });

  // Sharing someone else's tier is the site's ordinary profile share; this button is the owner's.
  it('never offers a visitor the share link, nor asks the server', () => {
    mocks.viewer = { id: OWNER + 1, username: 'visitor', meta: { scores: { total: 0 } } };
    mocks.shareable = true;
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(shareLinks(card)).toEqual([]);
    expect(mocks.shareQueries.every((query) => !query.enabled)).toBe(true);
    expect(mocks.shareQueries.length).toBeGreaterThan(0);
  });
});
