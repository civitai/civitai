// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';
import {
  CREATOR_SCORE_EXPLAINER_HREF,
  CREATOR_SHOWCASE_HREF,
  HIDDEN_ACHIEVEMENT_PLACEHOLDER,
} from '~/shared/constants/creator-journey.constants';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Journey = React.ComponentProps<typeof CreatorJourneyView>['journey'];

const secret = (key: string, earned: boolean) => ({
  key,
  name: '???',
  hint: null,
  description: null,
  earned,
  badgeUrl: null,
  achievedAt: earned ? new Date('2026-10-06T00:00:00Z') : null,
});

const journey = (secrets: ReturnType<typeof secret>[] = []) =>
  ({
    scores: { total: 100, breakdown: {} },
    unlocks: [],
    tiers: [],
    earned: [],
    activity: { milestones: [], closestNext: null },
    secrets,
  } as unknown as Journey);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(value: Journey) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorJourneyView, { journey: value })
      )
    )
  );
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('journey page polish', () => {
  it('links the Creator Showcase from the page header', () => {
    const page = mount(journey());
    const hrefs = [...page.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(CREATOR_SHOWCASE_HREF);
  });

  // Justin asked for the explainer to drop down in place rather than send people to the account page.
  it('opens the Creator Score explainer in place instead of linking off', () => {
    const page = mount(journey());
    const hrefs = [...page.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain(CREATOR_SCORE_EXPLAINER_HREF);

    const toggle = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('How Creator Score is earned')
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(page.textContent).toContain('How Creator Score works');
  });

  it('shows the placeholder art on a hidden achievement not yet found, and not on a found one', () => {
    const page = mount(journey([secret('secret:a', false), secret('secret:b', true)]));
    const tiles = [...page.querySelectorAll('[data-state]')];
    const art = (state: string) =>
      tiles
        .filter((tile) => tile.getAttribute('data-state') === state)
        .map((tile) => tile.querySelector('img')?.getAttribute('src') ?? '');
    expect(art('locked')).toHaveLength(1);
    expect(art('locked')[0]).toContain(HIDDEN_ACHIEVEMENT_PLACEHOLDER);
    expect(art('earned')).toEqual(['']);
  });
});
