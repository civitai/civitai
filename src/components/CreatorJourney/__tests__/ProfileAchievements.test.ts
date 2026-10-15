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
  myShare: undefined as
    | { shareable: string[]; hiddenOnProfile: string[]; secret: string[] }
    | undefined,
  myShareEnabled: [] as boolean[],
  ladderTiers: [] as { key: string; name: string; threshold: number; hint: null; badgeUrl: null }[],
  ladderPending: false,
  ladderData: undefined as { unlocks: never[]; tiers: unknown[] } | undefined,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.viewer,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'creatorJourney.getMyShareStates': {
      useQuery: (_input: unknown, { enabled }: { enabled: boolean }) => {
        mocks.myShareEnabled.push(enabled);
        // Regardless of `enabled`: a disabled query can still serve a cached answer, so the card
        // must gate on ownership itself.
        return { data: mocks.myShare };
      },
    },
    'creatorJourney.getLadder': {
      useQuery: () => {
        if (mocks.ladderPending) return { data: undefined };
        // One object per ladder, as react-query keeps: a fresh one per render re-runs every effect
        // keyed on it, which production never does.
        if (mocks.ladderData?.tiers !== mocks.ladderTiers)
          mocks.ladderData = { unlocks: [], tiers: mocks.ladderTiers };
        return { data: mocks.ladderData };
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
  BADGE_CARD_GRID,
  ladderRungs,
  ProfileAchievementsList,
  SECRET_ACHIEVEMENT_LABEL,
  TierLadderBand,
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

// Any frame the list asked for has run by the time this one does.
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.viewer = null;
  mocks.myShare = undefined;
  mocks.myShareEnabled = [];
  mocks.ladderTiers = [];
  mocks.ladderPending = false;
  mocks.ladderData = undefined;
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

describe('profile tier band', () => {
  const tier = { key: 'score:star', name: 'Star', badgeUrl: null, achievedAt: EARNED };
  const OWN_SCORE = 824228;

  it('shows the owner their own score', () => {
    mocks.viewer = { id: OWNER, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER }));
    expect(card.textContent).toContain('Only you see this');
    expect(card.textContent).toContain('824,228');
  });

  it('says a tier granted at launch was earned before launch', () => {
    const card = mount(
      React.createElement(TierLadderBand, {
        tiers: [{ ...tier, achievedAt: null }],
        userId: OWNER,
      })
    );
    expect(card.textContent).toContain('Earned before launch');
  });

  // A signed-in visitor's session carries their own score, never the owner's; showing it here
  // would read as the owner's number.
  it('shows a visitor the tier and no score line', () => {
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER }));
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
    mocks.myShare = { shareable: ['score:star'], hiddenOnProfile: [], secret: [] };
    const card = mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER }));
    expect(shareLinks(card)).toEqual([
      {
        url: '/user/maker?milestone=star',
        title: 'I reached Star on Civitai',
        label: 'Share Star',
      },
    ]);
    expect(mocks.myShareEnabled.at(-1)).toBe(true);
  });

  it('offers no share link when the card would not render', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: OWN_SCORE } } };
    mocks.myShare = { shareable: ['score:nova'], hiddenOnProfile: ['score:star'], secret: [] };
    expect(
      shareLinks(mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER })))
    ).toEqual([]);
  });

  // A hidden tier is a secret like any other: the server says so, and the share text keeps it.
  it('keeps a secret tier secret in the share text', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: OWN_SCORE } } };
    mocks.myShare = { shareable: ['score:star'], hiddenOnProfile: [], secret: ['score:star'] };
    const [link] = shareLinks(
      mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER }))
    );
    expect(link.title).toBe('I unlocked a secret achievement on Civitai');
  });

  // Sharing someone else's tier is the site's ordinary profile share; this button is the owner's.
  it('never offers a visitor the share link, nor asks the server', () => {
    mocks.viewer = { id: OWNER + 1, username: 'visitor', meta: { scores: { total: 0 } } };
    mocks.myShare = { shareable: ['score:star'], hiddenOnProfile: [], secret: [] };
    const card = mount(React.createElement(TierLadderBand, { tiers: [tier], userId: OWNER }));
    expect(shareLinks(card)).toEqual([]);
    expect(mocks.myShareEnabled.length).toBeGreaterThan(0);
    expect(mocks.myShareEnabled.every((enabled) => !enabled)).toBe(true);
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
  const ladder = (...tiers: [string, string, number][]) =>
    tiers.map(([key, name, threshold]) => ({ key, name, threshold, hint: null, badgeUrl: null }));
  const rungs = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('[data-tier-ladder] > button')].map((rung) =>
      rung.getAttribute('aria-label')
    );

  // Justin's pick (2026-10-12): the tier as one band holding the whole ladder, not a tile beside a grid.
  it('heads the tab with the highest tier and every tier on the ladder, held ones dated', () => {
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: 1 } } };
    mocks.ladderTiers = ladder(
      ['score:spark', 'Spark', 100],
      ['score:blaze', 'Blaze', 10000],
      ['score:nova', 'Nova', 100000],
      ['score:legend', 'Legend', 10000000]
    );
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));

    const strip = el.querySelector<HTMLElement>('[data-tier-ladder]') as HTMLElement;
    // The highest tier heads the band, not the newest: Blaze was earned last.
    expect(strip.previousElementSibling?.textContent).toBe(
      // The leading N is the badge's fallback hexagon: no art in this fixture.
      'NCreator Score tierNovaEarned before launch'
    );
    const current = [...strip.children].filter(
      (rung) => rung.getAttribute('aria-current') === 'true'
    );
    expect(current.map((rung) => rung.getAttribute('aria-label'))).toEqual([
      'Nova: Earned before launch',
    ]);
    // `centredScrollLeft` measures from the strip, so the strip must be the rungs' offset parent.
    expect(strip.className.split(' ')).toContain('relative');
    // A visitor's own session score must never read as the owner's.
    expect(el.textContent).not.toContain('Only you see this');
    expect(rungs(el)).toEqual([
      'Spark: Earned before launch',
      'Blaze: Earned Sep 28, 2026',
      'Nova: Earned before launch',
      'Legend: Unlocks at 10,000,000 Creator Score',
    ]);
    const rungText = [...el.querySelectorAll('[data-tier-ladder] > button')].map((rung) =>
      [...rung.querySelectorAll('p')].map((line) => line.textContent)
    );
    // A floor, not the creator's score (lead's call, 2026-10-09).
    expect(rungText).toEqual([
      ['Spark', '100+'],
      ['Blaze', '10,000+'],
      ['Nova', '100,000+'],
      ['Legend', '10,000,000+'],
    ]);
    const greyed = [...el.querySelectorAll('[data-tier-ladder] > button')].map((rung) =>
      rung.firstElementChild?.className.split(' ').includes('grayscale')
    );
    expect(greyed).toEqual([false, false, false, true]);
    expect(grids(el)).toHaveLength(1);
  });

  it('shows the score split under the ladder, as shares, leaving out empty categories', () => {
    mocks.viewer = null;
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data: { ...data, scoreSplit: { models: 57, images: 24, articles: 0, users: 19 } },
        userId: OWNER,
      })
    );
    const split = el.querySelector<HTMLElement>('[data-testid="score-split"]') as HTMLElement;
    expect(split.textContent).toBe(
      'Where this Creator Score comes fromModels 57%Images 24%Followers 19%'
    );
    expect(split.parentElement?.querySelector('[data-tier-ladder]')).not.toBeNull();
    const ladderBand = el.querySelector('[data-tier-ladder]') as HTMLElement;
    expect(
      ladderBand.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('shows no score split when the server sends none', () => {
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data: { ...data, scoreSplit: null },
        userId: OWNER,
      })
    );
    expect(el.querySelector('[data-tier-ladder]')).not.toBeNull();
    expect(el.querySelector('[data-testid="score-split"]')).toBeNull();
  });

  it('shows the held tiers on the ladder while the public ladder loads', () => {
    mocks.ladderPending = true;
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(rungs(el)).toEqual([
      'Spark: Earned before launch',
      'Blaze: Earned Sep 28, 2026',
      'Nova: Earned before launch',
    ]);
  });

  it('orders each track dated first, then launch grants by metal', () => {
    const achievement = (key: string, name: string, achievedAt: Date | null) => ({
      key,
      track: key.split(':')[0],
      name,
      description: null,
      badgeUrl: null,
      achievedAt,
    });
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data: {
          tiers: [],
          achievements: [
            achievement('create:models-1', 'First Model', null),
            achievement('create:articles-1', 'First Article', EARNED),
            achievement('reach:followers-100', '100 Followers', null),
            achievement('create:models-500', '500 Models', null),
            achievement('reach:followers-10000', '10k Followers', null),
          ],
        },
        userId: OWNER,
      })
    );
    const names = (grid: HTMLElement) =>
      [...grid.children].map(
        (card) =>
          ['First Model', '500 Models', 'First Article', '100 Followers', '10k Followers'].find(
            (name) => [...card.querySelectorAll('*')].some((node) => node.textContent === name)
          ) ?? ''
      );
    expect(grids(el).map(names)).toEqual([
      ['First Article', '500 Models', 'First Model'],
      ['10k Followers', '100 Followers'],
    ]);
  });

  it('points the owner, and only the owner, at their journey', () => {
    const journeyLinks = (el: HTMLElement) =>
      [...el.querySelectorAll('a')].filter((a) => a.getAttribute('href') === '/creators/journey');
    mocks.viewer = { id: OWNER, meta: { scores: { total: 1 } } };
    const own = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(journeyLinks(own).map((a) => a.textContent)).toContain(
      'See your progress on your Creator Journey'
    );
    act(() => root?.unmount());
    container?.remove();
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: 1 } } };
    const visitor = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(journeyLinks(visitor)).toEqual([]);
  });

  it('shows the owner their own score on the hero', () => {
    mocks.viewer = { id: OWNER, meta: { scores: { total: 824228 } } };
    const el = mount(React.createElement(ProfileAchievementsList, { data, userId: OWNER }));
    expect(el.textContent).toContain('Only you see this: score 824,228');
  });

  // A shared tier link lands here with `?milestone=`; that tier's card is the one to look at.
  it('scrolls to and rings the tier a shared link named, and only that one', async () => {
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
      expect(spotlit[0].parentElement?.hasAttribute('data-tier-ladder')).toBe(true);
      expect(spotlit[0].className.split(' ')).toEqual(
        expect.arrayContaining(['ring-2', 'ring-inset', 'scroll-mt-24'])
      );
      await nextFrame();
      expect(scrolled).toEqual([spotlit[0]]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  // A shared achievement link names the achievement by its key; that card is the one to look at.
  it('scrolls to and rings the achievement a shared link named', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const el = mount(
        React.createElement(ProfileAchievementsList, {
          data,
          userId: OWNER,
          spotlight: 'create:models-25',
        })
      );
      const spotlit = [...el.querySelectorAll<HTMLElement>('[data-spotlight]')];
      expect(spotlit.map((node) => node.id)).toEqual(['achievement-create:models-25']);
      expect(spotlit[0].textContent).toContain('25 Models');
      await nextFrame();
      expect(scrolled).toEqual([spotlit[0]]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  // A visitor's special is keyed by its place in the list; the server marks the one the link named.
  it("rings and scrolls to a visitor's secret the server marked for the link", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const secret = (key: string, spotlit: boolean) => ({
      key,
      track: 'secret',
      name: null,
      description: null,
      badgeUrl: null,
      achievedAt: EARNED,
      spotlit,
    });
    try {
      const el = mount(
        React.createElement(ProfileAchievementsList, {
          data: { tiers: [], achievements: [secret('secret:0', false), secret('secret:1', true)] },
          userId: OWNER,
          spotlight: 'hidden:night-owl',
        })
      );
      const spotlit = [...el.querySelectorAll<HTMLElement>('[data-spotlight]')];
      expect(spotlit.map((node) => node.id)).toEqual(['achievement-hidden:night-owl']);
      expect(spotlit[0].textContent).toContain(SECRET_ACHIEVEMENT_LABEL);
      const cards = [...el.querySelectorAll<HTMLElement>('div')].find(
        (div) => div.className === BADGE_CARD_GRID
      )?.children;
      expect(cards?.[1]).toBe(spotlit[0]);
      await nextFrame();
      expect(scrolled).toEqual([spotlit[0]]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  // Landing from the profile, the list mounts with the page (the profile cached its data), and the
  // app's scroll area resets to the top in its own effect, after the list's. Scrolling in the list's
  // effect lost to that reset; the scroll must come after every effect of the commit.
  it('scrolls after the effects of the page it mounts with', async () => {
    const order: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      order.push('scroll');
    };
    function ScrollAreaLike({ children }: { children: React.ReactNode }) {
      React.useEffect(() => {
        order.push('reset');
      }, []);
      return React.createElement(React.Fragment, null, children);
    }
    try {
      mount(
        React.createElement(
          ScrollAreaLike,
          null,
          React.createElement(ProfileAchievementsList, { data, userId: OWNER, spotlight: 'blaze' })
        )
      );
      await nextFrame();
      expect(order).toEqual(['reset', 'scroll']);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  // The ring is drawn by the wrapper, which is the grid item: it must fill its cell and the card
  // must fill it, with the card's own radius. Pinned by class (component tests load no stylesheet).
  it('rings the card with a wrapper its card fills, at the card radius', () => {
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data,
        userId: OWNER,
        spotlight: 'create:models-25',
      })
    );
    const ring = el.querySelector<HTMLElement>('[data-spotlight]');
    const classes = ring?.className.split(' ') ?? [];
    expect(classes).toContain('grid');
    expect(classes).toContain('rounded-md');
    expect(classes.filter((c) => /^rounded(-|$)/.test(c))).toEqual(['rounded-md']);
    const card = ring?.firstElementChild as HTMLElement | null;
    expect(card?.className.split(' ')).toContain('rounded-md');
  });

  const achievementShareLinks = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-share-url]')].map((link) => ({
      url: link.getAttribute('data-share-url'),
      title: link.getAttribute('data-share-title'),
    }));
  const twoAchievements = {
    ...data,
    tiers: [],
    achievements: [
      ...data.achievements,
      {
        key: 'reach:followers-100',
        track: 'reach',
        name: '100 Followers',
        description: null,
        badgeUrl: null,
        achievedAt: EARNED,
      },
    ],
  };

  it('offers the owner a share link on each achievement whose card renders', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: 1 } } };
    mocks.myShare = { shareable: ['create:models-25'], hiddenOnProfile: [], secret: [] };
    const el = mount(
      React.createElement(ProfileAchievementsList, { data: twoAchievements, userId: OWNER })
    );
    expect(achievementShareLinks(el)).toEqual([
      { url: '/user/maker?milestone=create:models-25', title: 'I earned 25 Models on Civitai' },
    ]);
    expect(mocks.myShareEnabled.at(-1)).toBe(true);
  });

  it('keeps a secret achievement secret in its share text', () => {
    mocks.viewer = { id: OWNER, username: 'maker', meta: { scores: { total: 1 } } };
    mocks.myShare = {
      shareable: ['create:models-25', 'reach:followers-100'],
      hiddenOnProfile: [],
      secret: ['reach:followers-100'],
    };
    const el = mount(
      React.createElement(ProfileAchievementsList, { data: twoAchievements, userId: OWNER })
    );
    expect(achievementShareLinks(el).map((link) => link.title)).toEqual([
      'I earned 25 Models on Civitai',
      'I unlocked a secret achievement on Civitai',
    ]);
  });

  // The owner's share list is theirs: a visitor neither sees the buttons nor asks for it.
  it('never offers a visitor an achievement share link, nor asks the server', () => {
    mocks.viewer = { id: OWNER + 1, username: 'visitor', meta: { scores: { total: 0 } } };
    mocks.myShare = {
      shareable: ['create:models-25', 'reach:followers-100'],
      hiddenOnProfile: [],
      secret: [],
    };
    const el = mount(
      React.createElement(ProfileAchievementsList, { data: twoAchievements, userId: OWNER })
    );
    expect(achievementShareLinks(el)).toEqual([]);
    expect(mocks.myShareEnabled.length).toBeGreaterThan(0);
    expect(mocks.myShareEnabled.every((enabled) => !enabled)).toBe(true);
  });

  it('picks out nothing for a tier the creator does not hold', () => {
    const el = mount(
      React.createElement(ProfileAchievementsList, { data, userId: OWNER, spotlight: 'legend' })
    );
    expect(el.querySelectorAll('[data-spotlight]')).toHaveLength(0);
  });

  // On a phone the ladder scrolls sideways: a shared tier's rung must be centred in the strip, or the
  // page scrolls to a band whose ringed rung is off-screen. No stylesheet here, so layout is stubbed.
  it("centres a shared tier's rung in the ladder strip and scrolls the page to it", async () => {
    const calls: string[] = [];
    const strips: { el: Element; left: number | undefined }[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Element.prototype.scrollIntoView = function () {
      calls.push('page');
    };
    HTMLElement.prototype.scrollTo = function (
      this: HTMLElement,
      options?: ScrollToOptions | number
    ) {
      calls.push('strip');
      strips.push({ el: this, left: typeof options === 'object' ? options.left : undefined });
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      const el = mount(
        React.createElement(ProfileAchievementsList, { data, userId: OWNER, spotlight: 'nova' })
      );
      const rung = el.querySelector<HTMLElement>('[data-spotlight]') as HTMLElement;
      const strip = el.querySelector<HTMLElement>('[data-tier-ladder]') as HTMLElement;
      Object.defineProperty(rung, 'offsetLeft', { value: 400 });
      Object.defineProperty(rung, 'offsetWidth', { value: 64 });
      Object.defineProperty(strip, 'clientWidth', { value: 300 });
      await nextFrame();
      expect([...calls].sort()).toEqual(['page', 'strip']);
      expect(strips).toEqual([{ el: strip, left: 400 - (300 - 64) / 2 }]);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  // Seen on a real phone: centred while only the held tiers were on the strip, the rung then moved
  // right when the rest of the ladder arrived, and the ring ended off-screen.
  it('centres the rung where it sits once the whole ladder is in', async () => {
    const lefts: (number | undefined)[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const offsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
      lefts.push(typeof options === 'object' ? options.left : undefined);
    } as typeof HTMLElement.prototype.scrollTo;
    // Each rung 72px wide, laid out left to right; the strip shows 300px.
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement ? [...this.parentElement.children].indexOf(this) * 72 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 72,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 300,
    });
    try {
      mocks.ladderPending = true;
      mocks.ladderTiers = ladder(
        ['score:spark', 'Spark', 100],
        ['score:kindle', 'Kindle', 1000],
        ['score:flame', 'Flame', 5000],
        ['score:blaze', 'Blaze', 10000],
        ['score:nova', 'Nova', 100000],
        ['score:legend', 'Legend', 10000000]
      );
      const props = { data, userId: OWNER, spotlight: 'nova' };
      mount(React.createElement(ProfileAchievementsList, props));
      await nextFrame();
      expect(lefts).toEqual([]);

      mocks.ladderPending = false;
      act(() =>
        root?.render(
          React.createElement(
            MantineProvider,
            null,
            React.createElement(ProfileAchievementsList, props)
          )
        )
      );
      await nextFrame();
      // Nova is the fifth rung once the ladder is in.
      expect(lefts).toEqual([4 * 72 - (300 - 72) / 2]);

      // A later render with the same ladder leaves the strip where the viewer scrolled it.
      act(() =>
        root?.render(
          React.createElement(
            MantineProvider,
            null,
            React.createElement(ProfileAchievementsList, props)
          )
        )
      );
      await nextFrame();
      expect(lefts).toHaveLength(1);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      HTMLElement.prototype.scrollTo = originalScrollTo;
      if (offsetLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsetLeft);
      else delete (HTMLElement.prototype as { offsetLeft?: number }).offsetLeft;
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it('moves no strip for an achievement a shared link named', async () => {
    const strips: Element[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = function (this: HTMLElement) {
      strips.push(this);
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      mount(
        React.createElement(ProfileAchievementsList, {
          data,
          userId: OWNER,
          spotlight: 'create:models-25',
        })
      );
      await nextFrame();
      expect(strips).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it('nudges an owner with no tier toward the first, and shows a visitor nothing', () => {
    mocks.ladderTiers = ladder(['score:spark', 'Spark', 500], ['score:kindle', 'Kindle', 1000]);
    const noTiers = { ...data, tiers: [] };
    mocks.viewer = { id: OWNER, meta: { scores: { total: 1 } } };
    const own = mount(
      React.createElement(ProfileAchievementsList, { data: noTiers, userId: OWNER })
    );
    expect(own.textContent).toContain('No Creator Score tier yet. Spark unlocks at 500.');
    expect(own.querySelector('[data-tier-ladder]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: 1 } } };
    const visitor = mount(
      React.createElement(ProfileAchievementsList, { data: noTiers, userId: OWNER })
    );
    expect(visitor.textContent).not.toContain('Creator Score tier');
    expect(visitor.textContent).not.toContain('No Creator Score tier yet');
  });

  it('names no masked first tier, nor its threshold, in the nudge', () => {
    mocks.ladderTiers = ladder(['hidden:tier-0', '???', 500], ['score:kindle', 'Kindle', 1000]);
    mocks.viewer = { id: OWNER, meta: { scores: { total: 1 } } };
    const own = mount(
      React.createElement(ProfileAchievementsList, { data: { ...data, tiers: [] }, userId: OWNER })
    );
    expect(own.textContent).toContain('No Creator Score tier yet. Open your journey');
    expect(own.textContent).not.toContain('unlocks at');
    expect(own.textContent).not.toContain('500');
  });

  it('shows a masked rung as locked, with no threshold', () => {
    mocks.ladderTiers = ladder(
      ['score:spark', 'Spark', 100],
      ['hidden:tier-1', '???', 777777],
      ['score:blaze', 'Blaze', 10000]
    );
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data: { ...data, tiers: [data.tiers[0]] },
        userId: OWNER,
      })
    );
    const masked = el.querySelectorAll<HTMLElement>('[data-tier-ladder] > button')[1];
    expect(masked.getAttribute('aria-label')).toBe('???: Locked');
    expect([...masked.querySelectorAll('p')].map((line) => line.textContent)).toEqual(['???']);
    expect(el.textContent).not.toContain('777');
  });
});

describe('ladder rungs', () => {
  const held = (key: string, name: string) => ({
    key,
    name,
    badgeUrl: 'own-art',
    achievedAt: null,
  });
  const rung = (key: string, name: string, threshold: number) => ({
    key,
    name,
    threshold,
    hint: null,
    badgeUrl: 'ladder-art',
  });

  // The ladder masks a hidden tier's key and name for everyone. Its owner holds the real tier; a
  // visitor is never sent it, so the slot stays masked and shows no number.
  it("fills a masked slot with the owner's own hidden tier, and shows no threshold for it", () => {
    const ladder = [
      rung('score:spark', 'Spark', 500),
      rung('hidden:tier-1', '???', 1000),
      rung('hidden:tier-2', '???', 5000),
    ];
    const result = ladderRungs(
      [held('score:spark', 'Spark'), held('score:kindle', 'Kindle')],
      ladder
    );
    expect(result.map((r) => [r.key, r.name, r.threshold, !!r.held])).toEqual([
      ['score:spark', 'Spark', 500, true],
      ['score:kindle', 'Kindle', undefined, true],
      ['hidden:tier-2', '???', undefined, false],
    ]);
    expect(result[1].badgeUrl).toBe('own-art');
  });

  // A creator can hide a tier's badge from their profile; the score still passed it, so the ladder
  // must not call a rung under their top tier unreached. No date: that stays hidden.
  it('marks a shown-tier gap below the top held tier as reached, never a masked one', () => {
    const ladder = [
      rung('score:spark', 'Spark', 500),
      rung('hidden:tier-1', '???', 1000),
      rung('score:flame', 'Flame', 5000),
      rung('score:blaze', 'Blaze', 10000),
      rung('score:beacon', 'Beacon', 40000),
    ];
    const result = ladderRungs([held('score:blaze', 'Blaze')], ladder);
    expect(result.map((r) => [r.key, !!r.held, !!r.reached])).toEqual([
      ['score:spark', false, true],
      ['hidden:tier-1', false, false],
      ['score:flame', false, true],
      ['score:blaze', true, false],
      ['score:beacon', false, false],
    ]);
  });

  it('labels a reached rung without a date, lit, on the tab', () => {
    mocks.ladderTiers = [
      { key: 'score:spark', name: 'Spark', threshold: 500, hint: null, badgeUrl: 'spark-art' },
      { key: 'score:blaze', name: 'Blaze', threshold: 10000, hint: null, badgeUrl: 'blaze-art' },
    ] as unknown as typeof mocks.ladderTiers;
    const el = mount(
      React.createElement(ProfileAchievementsList, {
        data: { tiers: [held('score:blaze', 'Blaze')], achievements: [] },
        userId: OWNER,
      })
    );
    const [spark, blaze] = el.querySelectorAll<HTMLElement>('[data-tier-ladder] > button');
    expect(spark.getAttribute('aria-label')).toBe('Spark: Reached');
    expect(spark.firstElementChild?.className.split(' ')).not.toContain('grayscale');
    // The creator hid this badge, but its art is the public ladder's: a reached rung draws it, not a
    // lettered placeholder.
    expect(spark.querySelector('img')?.getAttribute('src')).toMatch(/^spark-art\//);
    expect(blaze.querySelector('img')?.getAttribute('src')).toMatch(/^own-art\//);
  });

  it('keeps a held tier the ladder does not list, after the ladder', () => {
    const result = ladderRungs(
      [held('score:spark', 'Spark'), held('score:mythic', 'Mythic')],
      [rung('score:spark', 'Spark', 500)]
    );
    expect(result.map((r) => r.key)).toEqual(['score:spark', 'score:mythic']);
    expect(result.every((r) => r.held)).toBe(true);
  });
});
