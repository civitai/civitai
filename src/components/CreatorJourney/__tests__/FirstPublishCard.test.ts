// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureNotice from '~/components/Alerts/useFeatureNotice';
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

const mocks = vi.hoisted(() => ({
  getFirstPublishCard: vi.fn(),
  getLadder: vi.fn(),
  currentUser: undefined as { id: number; meta?: unknown } | undefined,
  notice: { isDismissed: false, hasSettings: true },
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
  useFeatureNotice: () => ({ ...mocks.notice, dismiss: vi.fn() }),
}));

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ladder = {
  unlocks: buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs),
  tiers: [
    { key: 'score:spark', name: 'Spark', threshold: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE, hint: null },
    { key: 'score:flame', name: 'Flame', threshold: CHALLENGE_MIN_CREATOR_SCORE, hint: null },
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
      'Your first model is live | Downloads, generations and reviews on it now count toward your ' +
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
      /^Your first article is live \| Reads, reactions and comments on it now count toward your Creator Score\. Your next goal is Flame at 5,000, which unlocks: /
    );
  });

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
    mocks.notice = { isDismissed: false, hasSettings: true };
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

  it('asks the server for the owner of a recently published model', () => {
    render();
    expect(askedServer()).toBe(true);
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
  });

  it('never asks once dismissed, or before settings resolve', () => {
    mocks.notice = { isDismissed: true, hasSettings: true };
    render();
    expect(askedServer()).toBe(false);
    unmount();

    mocks.notice = { isDismissed: false, hasSettings: false };
    render();
    expect(askedServer()).toBe(false);
  });

  it('renders only when the server says it is the first', () => {
    mocks.getLadder.mockReturnValue({ data: ladder });
    mocks.getFirstPublishCard.mockReturnValue({ data: { show: false } });
    expect(render().textContent).not.toMatch(/first model is live/);
    unmount();

    mocks.getFirstPublishCard.mockReturnValue({ data: { show: true } });
    expect(render().textContent).toMatch(/Your first model is live/);
  });
});
