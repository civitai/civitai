// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

// The site share popover needs the app's providers; what it is handed is what this file checks.
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ url, title, children }: { url: string; title: string; children: never }) =>
    React.createElement('span', { 'data-share-url': url, 'data-share-title': title }, children),
}));

import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Journey = React.ComponentProps<typeof CreatorJourneyView>['journey'];
type Earned = Journey['earned'][number];

const badge = (key: string, name: string, track = 'score'): Earned => ({
  key,
  track,
  threshold: 500,
  name,
  description: null,
  badgeUrl: track === 'score' ? null : 'https://example.test/badge.png',
  achievedAt: new Date('2026-10-06T00:00:00Z'),
});

const EARNED = [
  badge('score:spark', 'Spark'),
  badge('score:supernova', 'Supernova'),
  badge('create:models-1', 'First Model', 'create'),
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function shareLinks(shareableTiers: string[], username?: string) {
  const journey = {
    scores: null,
    unlocks: [],
    tiers: [],
    earned: EARNED,
    activity: { milestones: [], closestNext: null },
    secrets: [],
    shareableTiers,
  } as unknown as Journey;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorJourneyView, { journey, username })
      )
    )
  );
  return [...container.querySelectorAll('[data-share-url]')].map((el) => ({
    url: el.getAttribute('data-share-url'),
    title: el.getAttribute('data-share-title'),
    label: el.querySelector('button')?.getAttribute('aria-label'),
  }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('tier share buttons on the journey shelf', () => {
  it('offers a share link only for tiers whose card renders', () => {
    expect(shareLinks(['supernova'], 'maker')).toEqual([
      {
        url: '/user/maker?milestone=supernova',
        title: 'I reached Supernova on Civitai',
        label: 'Share Supernova',
      },
    ]);
  });

  it('offers one per shareable tier, and none for a badge that is not a tier', () => {
    expect(shareLinks(['spark', 'supernova'], 'maker').map((link) => link.label)).toEqual([
      'Share Spark',
      'Share Supernova',
    ]);
  });

  it('offers nothing when no tier is shareable, or there is no username to link to', () => {
    expect(shareLinks([], 'maker')).toEqual([]);
    act(() => root?.unmount());
    container?.remove();
    expect(shareLinks(['supernova'])).toEqual([]);
  });
});
