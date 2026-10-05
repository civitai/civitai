// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import {
  CREATOR_SCORE_EXPLAINER_HREF,
  CreatorScoreExplainer,
  creatorScoreSources,
} from '~/components/Account/CreatorScoreExplainer';
import { UserScoreDisplay } from '~/components/Account/UserScoreDisplay';

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
function visibleText(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement;
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

    expect(text).toContain(
      'Models: Downloads, generations, and positive reviews of published models'
    );
    expect(text).toContain('Images: Reactions and comments on images');
    expect(text).toContain('Articles: Views, reactions, and comments on articles');
    expect(text).toContain('Followers: Follower count');
    expect(text).toContain('Helping moderation: Reports filed that moderators act on');
    expect(text).toContain('Content removed for breaking our rules takes points away.');
    expect(text).toContain('updates once a day');
    expect(text).toContain('never resets or expires');
  });

  // Justin, 2026-10-05: categories and activities only. Weights are tunable and may change, so
  // the public copy states no numbers. If you are adding a figure here, that decision is his.
  it('states no number anywhere, so it cannot publish a weight', () => {
    const text = visibleText(render(React.createElement(CreatorScoreExplainer)));

    expect(text.match(/\d+/g)).toBeNull();
  });

  it('links to the journey page only when given a route for it', () => {
    const without = render(React.createElement(CreatorScoreExplainer));
    expect(without.querySelectorAll('a')).toHaveLength(0);
    act(() => root?.unmount());
    container?.remove();

    const withLink = render(
      React.createElement(CreatorScoreExplainer, { journeyHref: '/journey-route-under-test' })
    );
    const hrefs = [...withLink.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/journey-route-under-test']);
  });
});

// Score-gate refusals and the Creator Program pages already link to this exact URL.
it('keeps the explainer at the account creator-score anchor', () => {
  expect(CREATOR_SCORE_EXPLAINER_HREF).toBe('/user/account#creator-score');
});

describe('UserScoreDisplay category legend', () => {
  it('labels each category with the explainer copy', () => {
    const text = visibleText(
      render(
        React.createElement(UserScoreDisplay, {
          scores: { total: 40, models: 10, images: 10, articles: 10, users: 10 },
        })
      )
    );

    for (const key of ['models', 'images', 'articles', 'users'] as const) {
      expect(text).toContain(creatorScoreSources[key].label);
    }
    expect(text).not.toContain('Users');
  });
});
