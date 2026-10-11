// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const strikesQuery: { data: undefined; isLoading: boolean } = { data: undefined, isLoading: false };
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'strike.getMyStrikeSummary': { useQuery: () => strikesQuery },
    'strike.getMyStrikes': { useQuery: () => strikesQuery },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ meta: { scores: { total: 20, models: 10, users: 10 } } }),
}));

const { CreatorScoreExplainer } = await import('~/components/Account/CreatorScoreExplainer');
const { creatorScorePenalty, creatorScoreSources } = await import(
  '~/components/Account/creator-score-copy'
);
const { UserScoreDisplay, scoreCategories } = await import('~/components/Account/UserScoreDisplay');
const { StrikesCard } = await import('~/components/Account/StrikesCard');

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(MantineProvider, null, element));
  });
  return container;
}

// MantineProvider injects <style> tags whose CSS would otherwise read as page copy.
function visibleText(el: Element) {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('style').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('CreatorScoreExplainer', () => {
  it('names every scored category and the activity behind it', () => {
    const text = visibleText(render(React.createElement(CreatorScoreExplainer)));

    expect(text).toContain('It grows when people use, react to, and follow your work.');
    expect(text).toContain('Models: Downloads, generations, and positive reviews of models');
    expect(text).toContain('Images: Reactions and comments on images');
    expect(text).toContain('Articles: Views, reactions, and comments on articles');
    expect(text).toContain('Followers: Follower count');
    expect(text).toContain('Helping moderation: Reports filed that moderators act on');
    expect(text).toContain('Images removed for breaking our rules take points away.');
    expect(text).toContain('If people unfollow you or remove a reaction, those points go too.');
    expect(text).toContain('updates once a day');
    expect(text).toContain('never resets or expires');
  });

  // Product decision: categories and activities only. Weights are tunable and may change, so
  // the public copy states no numbers. Tooltips are not in the DOM until hover, so they are
  // checked as data.
  it('states no number anywhere, so it cannot publish a weight', () => {
    const rendered = visibleText(render(React.createElement(CreatorScoreExplainer)));
    const tooltips = scoreCategories.map(({ tooltip }) => tooltip);

    for (const copy of [rendered, creatorScorePenalty, ...tooltips]) {
      expect(copy.match(/\d+/g)).toBeNull();
    }
  });
});

describe('UserScoreDisplay category legend', () => {
  it('takes each label and tooltip from the explainer copy', () => {
    expect(scoreCategories.map(({ key, label, tooltip }) => ({ key, label, tooltip }))).toEqual(
      (['models', 'images', 'articles', 'users'] as const).map((key) => ({
        key,
        label: creatorScoreSources[key].label,
        tooltip: creatorScoreSources[key].earnedBy,
      }))
    );
  });

  it('renders the Followers label, not Users', () => {
    const text = visibleText(
      render(
        React.createElement(UserScoreDisplay, {
          scores: { total: 40, models: 10, images: 10, articles: 10, users: 10 },
        })
      )
    );

    expect(text).toContain('Followers');
    expect(text).not.toContain('Users');
  });
  // Tester (2026-10-10): the bar's numbers were hover-only, so a phone could never see them.
  it('prints each category’s points in the legend, not only in a hover', () => {
    const text = visibleText(
      render(
        React.createElement(UserScoreDisplay, {
          scores: { total: 1244, models: 1234, images: 10, articles: 0, users: 0 },
          abbreviate: false,
        })
      )
    );
    expect(text).toContain('Models 1,234');
    expect(text).toContain('Images 10');
    expect(text).not.toContain('Articles');
  });
});

describe('UserScoreDisplay reports block', () => {
  const reports = (props: Record<string, unknown>) =>
    visibleText(
      render(
        React.createElement(UserScoreDisplay, {
          scores: { total: 10, models: 10, reportsActioned: 0, reportsAgainst: 0 },
          showReports: true,
          ...props,
        })
      )
    );

  // The journey page is the creator's own: "Helping moderation" is how the explainer names it.
  it('speaks to the owner in the explainer’s words, with zeros shown plainly', () => {
    const text = reports({ owner: true });
    expect(text).toContain(creatorScoreSources.reportsActioned.label);
    expect(text).toContain('Removed content');
    expect(text).not.toContain('Actioned');
    expect(text.match(/0 pts/g)).toHaveLength(2);
  });

  it('keeps the moderator wording everywhere else', () => {
    const text = reports({});
    expect(text).toContain('Actioned');
    expect(text).toContain('Against');
    expect(text).not.toContain(creatorScoreSources.reportsActioned.label);
  });
});

describe('StrikesCard', () => {
  it.each([
    ['settings pane', { flat: true }],
    ['legacy card', { flat: false }],
  ])('puts the explainer inside the creator-score anchor (%s)', (_, props) => {
    const el = render(React.createElement(StrikesCard, props));
    const anchor = el.querySelector('#creator-score');

    expect(anchor).not.toBeNull();
    expect(visibleText(anchor as Element)).toContain('How Creator Score works');
  });

  // The account shell keeps the fragment when it redirects a legacy link to this pane; this is
  // what that fragment is for.
  it.each([
    ['#creator-score', ['creator-score']],
    ['', []],
  ])('scrolls to the matching anchor when the URL hash is %j', (hash, scrolledTo) => {
    window.history.replaceState(null, '', `/user/account/profile${hash}`);
    const scroll = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    try {
      render(React.createElement(StrikesCard, { flat: true }));

      expect(scroll.mock.contexts.map((node) => (node as HTMLElement).id)).toEqual(scrolledTo);
    } finally {
      scroll.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });

  // The anchor only renders once the strikes query settles, which is why the scroll lives in a ref
  // rather than a mount effect: a mount-time scroll would find nothing.
  it('scrolls once the card finishes loading, and only once', () => {
    window.history.replaceState(null, '', '/user/account/profile#creator-score');
    const scroll = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    strikesQuery.isLoading = true;
    try {
      const renderCard = () =>
        React.createElement(
          MantineProvider,
          null,
          React.createElement(StrikesCard, { flat: true })
        );
      render(React.createElement(StrikesCard, { flat: true }));
      expect(scroll).not.toHaveBeenCalled();

      strikesQuery.isLoading = false;
      act(() => root?.render(renderCard()));
      act(() => root?.render(renderCard()));

      expect(scroll.mock.contexts.map((node) => (node as HTMLElement).id)).toEqual([
        'creator-score',
      ]);
    } finally {
      strikesQuery.isLoading = false;
      scroll.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });
});
