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
  ladderTiers: [] as { key: string; threshold: number }[],
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
        // Regardless of `enabled`: a disabled query still serves a cached answer, and the profile
        // page prefetches this one for `?milestone=` links.
        return { data: mocks.shareable };
      },
    },
    'creatorJourney.getLadder': {
      useQuery: () => ({ data: { unlocks: [], tiers: mocks.ladderTiers } }),
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
  BADGE_CARD_GRID,
  ProfileAchievementsList,
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
  mocks.ladderTiers = [];
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
    expect(SECRET_ACHIEVEMENT_LABEL).toBe('Special achievement');
    expect(card.textContent).toContain('Special achievement');
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

  // Justin (2026-10-10): the owner's earned special keeps its hint, above the description.
  it('shows an earned special its hint above the description', () => {
    const text =
      mount(
        React.createElement(AchievementCard, {
          achievement: {
            key: 'hidden:remix',
            track: 'secret',
            name: 'Remixed',
            description: 'Someone remixed your model.',
            hint: 'Someone builds on your work',
            badgeUrl: null,
            achievedAt: EARNED,
          },
        })
      ).textContent ?? '';
    const hintAt = text.indexOf('Someone builds on your work');
    expect(hintAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(text.indexOf('Someone remixed your model.'));
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

describe('achievements tab', () => {
  const tier = (key: string, name: string, achievedAt: Date | null) => ({
    key,
    name,
    badgeUrl: null,
    achievedAt,
  });
  const data = {
    tiers: [
      tier('score:spark', 'Spark', null),
      tier('score:blaze', 'Blaze', EARNED),
      tier('score:nova', 'Nova', null),
    ],
    achievements: [
      {
        key: 'create:models-25',
        track: 'create',
        name: '25 Models',
        description: null,
        badgeUrl: null,
        achievedAt: EARNED,
      },
    ],
  };
  const grids = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('div')].filter((div) => div.className === BADGE_CARD_GRID);
  // Cards only: the hero above the grid also names the highest tier.
  const cardOf = (el: HTMLElement, name: string) =>
    grids(el)
      .flatMap((grid) => [...grid.children] as HTMLElement[])
      .find((card) => [...card.querySelectorAll('*')].some((node) => node.textContent === name));

  // Ellie's review (2026-10-09): the tier list was bare badges; it reads like the journey page now.
  it('heads the tab with the highest tier, then a card per tier with its threshold and date', () => {
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: 1 } } };
    // The ladder masks a hidden tier's key but not its threshold, in ladder order: Nova's real
    // number is in the list, third, under another key. Matching by key keeps it off the card.
    mocks.ladderTiers = [
      { key: 'score:spark', threshold: 100 },
      { key: 'score:blaze', threshold: 10000 },
      { key: 'hidden:tier-2', threshold: 500000 },
    ];
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));

    const hero = [...el.querySelectorAll<HTMLElement>('div')].find(
      (div) => div.className === 'md:self-start'
    );
    expect(hero?.textContent).toContain('Creator Score tier');
    expect(hero?.textContent).toContain('Nova');
    // A visitor's own session score must never read as the owner's.
    expect(el.textContent).not.toContain('Only you see this');
    const names = [...grids(el)[0].children].map(
      (card) =>
        ['Nova', 'Blaze', 'Spark'].find((name) =>
          [...card.querySelectorAll('*')].some((node) => node.textContent === name)
        ) ?? ''
    );
    expect(names).toEqual(['Nova', 'Blaze', 'Spark']);
    // A floor, not the creator's score (lead's call, 2026-10-09).
    expect(cardOf(el, 'Blaze')?.textContent).toContain('10,000+Creator Score');
    expect(cardOf(el, 'Blaze')?.textContent).toContain('Earned Sep 28, 2026');
    expect(cardOf(el, 'Spark')?.textContent).toContain('100+Creator Score');
    // A backfilled tier has no observed date: plain "Earned", like the journey page.
    expect(cardOf(el, 'Spark')?.textContent).toMatch(/Earned$/);
    expect(cardOf(el, 'Nova')?.textContent).not.toMatch(/\d/);
  });

  it('shows the owner their own score on the hero', () => {
    mocks.viewer = { id: OWNER, meta: { scores: { total: 824228 } } };
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(el.textContent).toContain('Only you see this: score 824,228');
  });

  // A shared tier link lands here with `?milestone=`; that tier's card is the one to look at.
  it('scrolls to and rings the tier a shared link named, and only that one', () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const el = mount(
        React.createElement(ProfileAchievementsList, { data, userId: OWNER, spotlight: 'blaze' })
      );
      const spotlit = [...el.querySelectorAll<HTMLElement>('[data-spotlight]')];
      expect(spotlit.map((node) => node.id)).toEqual(['tier-blaze']);
      expect(spotlit[0].textContent).toContain('Blaze');
      expect(spotlit[0].className).toContain('ring-2');
      expect(scrolled).toEqual([spotlit[0]]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('picks out nothing for a tier the creator does not hold', () => {
    const el = mount(
      React.createElement(ProfileAchievementsList, { data, userId: OWNER, spotlight: 'legend' })
    );
    expect(el.querySelectorAll('[data-spotlight]')).toHaveLength(0);
  });

  // The width itself is a stylesheet fact the test environment cannot measure; what is pinned here
  // is that tiers and achievements share the one card grid.
  it('puts tier cards and achievement cards on the same card grid', () => {
    mocks.viewer = null;
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(grids(el)).toHaveLength(2);
    expect(grids(el)[1].textContent).toContain('25 Models');
  });
});
