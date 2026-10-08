// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureNotice from '~/components/Alerts/useFeatureNotice';
import { creatorScoreSources } from '~/components/Account/creator-score-copy';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import {
  FirstPublishCard,
  FirstPublishCardView,
} from '~/components/CreatorJourney/FirstPublishCard';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import {
  CREATOR_JOURNEY_HREF,
  FIRST_PUBLISH_CARD_DAYS,
} from '~/shared/constants/creator-journey.constants';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { MIN_CREATOR_SCORE } from '~/shared/constants/creator-program.constants';

const mocks = vi.hoisted(() => ({
  getFirstPublishCard: vi.fn(),
  getLadder: vi.fn(),
  currentUser: undefined as { id: number; meta?: unknown } | undefined,
  notice: { isDismissed: false, hasSettings: true, isInAudience: true },
  useFeatureNotice: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const original = await importOriginal<typeof Trpc>();
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...original,
    trpc: makeTrpcProxy({
      'creatorJourney.getFirstPublishCard': { useQuery: mocks.getFirstPublishCard },
      'creatorJourney.getLadder': { useQuery: mocks.getLadder },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.currentUser,
}));
vi.mock('~/components/Alerts/useFeatureNotice', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureNotice>()),
  useFeatureNotice: mocks.useFeatureNotice,
}));

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ladder = {
  unlocks: buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs),
  tiers: [
    { key: 'score:spark', name: 'Spark', threshold: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE, hint: null },
    { key: 'score:flame', name: 'Flame', threshold: CHALLENGE_MIN_CREATOR_SCORE, hint: null },
    { key: 'score:supernova', name: 'Supernova', threshold: 1_000_000, hint: null },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(MantineProvider, null, element)));
  return container;
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
}

const paragraphs = (el: HTMLElement) =>
  [...el.querySelectorAll('p')].map((p) => p.textContent).join(' | ');

afterEach(unmount);

describe('FirstPublishCardView', () => {
  it('sets a creator with no tier their first goal, and links to the journey', () => {
    const el = mount(
      React.createElement(FirstPublishCardView, {
        entityType: 'model',
        total: 40,
        ladder,
        onClose: () => undefined,
      })
    );

    expect(paragraphs(el)).toBe(
      'Your first model is live | Downloads, generations, and positive reviews on it now count toward your ' +
        'Creator Score. Your first goal is Spark at 500, which unlocks: judge crucibles. | ' +
        'See your journey · Close'
    );
    expect(el.querySelector('a')?.getAttribute('href')).toBe(CREATOR_JOURNEY_HREF);
  });

  it('names the real next tier for a creator already past Spark', () => {
    const el = mount(
      React.createElement(FirstPublishCardView, {
        entityType: 'article',
        total: CHALLENGE_MIN_CREATOR_SCORE - 1,
        ladder,
        onClose: () => undefined,
      })
    );

    expect(paragraphs(el)).toMatch(
      /^Your first article is live \| Views, reactions, and comments on it now count toward your Creator Score\. Your next goal is Flame at 5,000, which unlocks: /
    );
  });

  // A prestige tier gates nothing, but it is still the next goal.
  it('names a next tier that unlocks nothing, without an unlocks clause', () => {
    const el = mount(
      React.createElement(FirstPublishCardView, {
        entityType: 'model',
        total: 900_000,
        ladder,
        onClose: () => undefined,
      })
    );

    expect(paragraphs(el)).toContain('Your next goal is Supernova at 1,000,000. |');
  });

  // The Creator Program gate compares the aggregate score, which can sit above the total, so an
  // unlock already reached on aggregate must not be listed as still to come.
  it('judges an aggregate-score unlock against the aggregate score', () => {
    const total = MIN_CREATOR_SCORE - 1;
    const view = (aggregate?: number) =>
      React.createElement(FirstPublishCardView, {
        entityType: 'model',
        total,
        aggregate,
        ladder,
        onClose: () => undefined,
      });

    expect(paragraphs(mount(view()))).toContain('join the Creator Program');
    unmount();
    const text = paragraphs(mount(view(MIN_CREATOR_SCORE)));
    expect(text).toContain('Your next goal is Supernova at 1,000,000');
    expect(text).not.toContain('join the Creator Program');
  });

  // The card and the score explainer must name the same activities; hand-written card copy drifted.
  it.each([
    ['model', creatorScoreSources.models.earnedBy],
    ['article', creatorScoreSources.articles.earnedBy],
  ] as const)(
    'names a %s card’s activities in the score explainer’s words',
    (entityType, earnedBy) => {
      const el = mount(
        React.createElement(FirstPublishCardView, {
          entityType,
          total: 0,
          ladder,
          onClose: () => undefined,
        })
      );
      const counts = el.querySelectorAll('p')[1]?.textContent ?? '';
      const activities = counts.slice(0, counts.indexOf(' on it now count'));
      expect(activities).toBe(earnedBy.replace(/ (of|on) \w+$/, ''));
    }
  );

  it('closes through the handler it is given', () => {
    const onClose = vi.fn();
    const el = mount(
      React.createElement(FirstPublishCardView, { entityType: 'model', total: 0, ladder, onClose })
    );
    act(() => (el.querySelector('button') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FirstPublishCard', () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000);
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    mocks.getFirstPublishCard.mockReset().mockReturnValue({ data: undefined });
    mocks.getLadder.mockReset().mockReturnValue({ data: undefined });
    mocks.currentUser = { id: 7 };
    mocks.notice = { isDismissed: false, hasSettings: true, isInAudience: true };
    mocks.useFeatureNotice
      .mockReset()
      .mockImplementation(() => ({ ...mocks.notice, dismiss: vi.fn() }));
  });

  const render = (props: Partial<React.ComponentProps<typeof FirstPublishCard>> = {}) =>
    mount(
      React.createElement(FirstPublishCard, {
        entityType: 'model',
        entityId: 1,
        ownerId: 7,
        publishedAt: recent,
        ...props,
      })
    );

  const askedServer = () => mocks.getFirstPublishCard.mock.lastCall?.[1]?.enabled;
  const askedLadder = () => mocks.getLadder.mock.lastCall?.[1]?.enabled;

  it('asks the server for the owner of a recently published model', () => {
    render();
    expect(askedServer()).toBe(true);
    expect(mocks.useFeatureNotice.mock.lastCall?.[1]).toEqual({ enabled: true });
  });

  // `undefined === undefined` is true, so an uncoerced owner check would send a protected request
  // from every signed-out view of one of the busiest pages on the site.
  it('never asks while signed out, even before the owner is known', () => {
    mocks.currentUser = undefined;
    render({ ownerId: undefined });
    expect(askedServer()).toBe(false);
  });

  it.each([
    ['for someone else', { ownerId: 8 }],
    [
      'past the window',
      { publishedAt: new Date(Date.now() - (FIRST_PUBLISH_CARD_DAYS + 1) * DAY_MS) },
    ],
    ['without a publish date', { publishedAt: null }],
  ])('never asks %s', (_label, props) => {
    render(props);
    expect(askedServer()).toBe(false);
    expect(askedLadder()).toBe(false);
    expect(mocks.useFeatureNotice.mock.lastCall?.[1]).toEqual({ enabled: false });
  });

  it('still asks on the last day of the window', () => {
    render({ publishedAt: new Date(Date.now() - (FIRST_PUBLISH_CARD_DAYS - 0.5) * DAY_MS) });
    expect(askedServer()).toBe(true);
  });

  it('never asks outside the notice audience', () => {
    mocks.notice = { isDismissed: false, hasSettings: true, isInAudience: false };
    render();
    expect(askedServer()).toBe(false);
  });

  // One card, two notices: closing the model card must not hide the article card, or the reverse.
  it.each([
    ['model', FEATURE_NOTICES.firstModelPublished],
    ['article', FEATURE_NOTICES.firstArticlePublished],
  ] as const)('reads its own notice for a %s', (entityType, notice) => {
    render({ entityType });
    expect(mocks.useFeatureNotice.mock.lastCall?.[0]).toBe(notice);
  });

  it('never asks once dismissed, or before settings resolve', () => {
    mocks.notice = { isDismissed: true, hasSettings: true, isInAudience: true };
    render();
    expect(askedServer()).toBe(false);
    unmount();

    mocks.notice = { isDismissed: false, hasSettings: false, isInAudience: true };
    render();
    expect(askedServer()).toBe(false);
  });

  it('renders only when the server says it is the first', () => {
    mocks.getLadder.mockReturnValue({ data: ladder });
    mocks.getFirstPublishCard.mockReturnValue({ data: { show: false } });
    expect(render().textContent).not.toMatch(/first model is live/);
    expect(askedLadder()).toBe(false);
    unmount();

    mocks.getFirstPublishCard.mockReturnValue({ data: { show: true } });
    expect(render().textContent).toMatch(/Your first model is live/);
  });

  it('reads the aggregate score from the session', () => {
    mocks.getLadder.mockReturnValue({ data: ladder });
    mocks.getFirstPublishCard.mockReturnValue({ data: { show: true } });
    mocks.currentUser = {
      id: 7,
      meta: { scores: { total: MIN_CREATOR_SCORE - 1, models: MIN_CREATOR_SCORE } },
    };
    const text = paragraphs(render());
    expect(text).toContain('Your next goal is Supernova');
    expect(text).not.toContain('join the Creator Program');
  });
});
