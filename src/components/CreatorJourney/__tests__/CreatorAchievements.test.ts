// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorAchievements, measureHref } from '~/components/CreatorJourney/CreatorAchievements';
import { buildActivityProgress } from '~/server/services/creator-journey.service';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition = (key: string, threshold: number, name: string) => ({
  key,
  track: key.split(':')[0],
  threshold,
  hidden: false,
  hint: null,
  name,
  description: null,
});

const definitions = [
  definition('create:models-1', 1, 'First Model'),
  definition('create:models-5', 5, '5 Models'),
  definition('create:models-25', 25, '25 Models'),
  definition('reach:followers-100', 100, '100 Followers'),
  definition('reach:followers-1000', 1000, '1k Followers'),
  definition('earn:shop-sales-100000', 100000, '100k Sales'),
  definition('earn:shop-sales-250000', 250000, '250k Sales'),
  definition('earn:shop-sales-500000', 500000, '500k Sales'),
  definition('community:crucible-votes-500', 500, '500 Votes'),
  definition('community:crucible-votes-1000', 1000, '1k Votes'),
  definition('community:crucible-votes-5000', 5000, '5k Votes'),
  definition('compete:wins-1', 1, 'First Win'),
  definition('compete:wins-5', 5, '5 Wins'),
  definition('compete:wins-10', 10, '10 Wins'),
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(
  held: Map<string, Date | null>,
  followers = 87,
  models = 3,
  revenue = 0,
  votes = 0,
  wins = 0,
  winBreakdown = { challenges: wins, crucibles: 0 }
) {
  const activity = {
    ...buildActivityProgress(definitions, held, {
      models,
      articles: 0,
      downloads: 0,
      followers,
      reactions: 0,
      revenue,
      votes,
      wins,
    }),
    winBreakdown,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorAchievements, { activity })
      )
    )
  );
  return container;
}

// Exact name match: '5 Models' is a substring of '25 Models'.
const tile = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('[data-state]')].find((t) =>
    [...t.querySelectorAll('*')].some((node) => node.textContent === name)
  );

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Achievements section', () => {
  it('calls out the milestone nearest to done', () => {
    const el = render(new Map([['create:models-1', null]]));
    expect(el.textContent).toContain('Closest next');
    expect(el.textContent).toContain('13 more for 100 Followers.');
  });

  it('marks each tile earned, in progress (next only) or locked', () => {
    const el = render(new Map([['create:models-1', new Date('2026-03-04T12:00:00')]]));
    expect(tile(el, 'First Model')?.dataset.state).toBe('earned');
    expect(tile(el, 'First Model')?.textContent).toContain('Earned Mar 4, 2026');
    expect(tile(el, '5 Models')?.dataset.state).toBe('progress');
    expect(tile(el, '5 Models')?.textContent).toContain('3 / 5');
    expect(tile(el, '25 Models')?.dataset.state).toBe('locked');
    expect(tile(el, '1k Followers')?.dataset.state).toBe('locked');
  });

  it('shows an undated grant as plain Earned', () => {
    const el = render(new Map([['create:models-1', null]]));
    expect(tile(el, 'First Model')?.textContent).toMatch(/Earned$/);
  });

  // A creator who unpublished after the grant keeps the badge; the next tier up is still the target.
  it('keeps an earned milestone earned when the count has since dropped below it', () => {
    const el = render(new Map([['create:models-1', null]]), 87, 0);
    expect(tile(el, 'First Model')?.dataset.state).toBe('earned');
    expect(tile(el, '5 Models')?.dataset.state).toBe('progress');
  });

  // Reached but not granted yet (the job runs nightly): neither earned nor the next target.
  it('does not show an ungranted milestone as earned', () => {
    const el = render(new Map(), 150);
    expect(tile(el, '100 Followers')?.dataset.state).toBe('locked');
    expect(tile(el, '1k Followers')?.dataset.state).toBe('progress');
  });
});

describe('Shop track', () => {
  it('shows gross sales in Buzz against each revenue threshold', () => {
    const el = render(new Map([['earn:shop-sales-100000', null]]), 87, 3, 120000);
    // The leaf: an empty track's container has the same text as its header.
    const header = [...el.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Earn'
    );
    const earnTrack = header?.parentElement;
    expect(earnTrack && tile(earnTrack, '100k Sales')).toBeTruthy();
    expect(earnTrack?.textContent).toContain('Sales120,000 Buzz');
    expect(tile(el, '100k Sales')?.dataset.state).toBe('earned');
    expect(tile(el, '250k Sales')?.dataset.state).toBe('progress');
    expect(tile(el, '250k Sales')?.textContent).toContain('120,000 / 250,000');
    expect(tile(el, '500k Sales')?.textContent).toContain('500,000 Buzz in shop sales');
  });
});

describe('Community track', () => {
  it('shows Crucible votes cast against each judge rank, under its own header', () => {
    const el = render(new Map([['community:crucible-votes-500', null]]), 87, 3, 0, 640);
    const header = [...el.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Community'
    );
    const judgeTrack = header?.parentElement;
    expect(judgeTrack && tile(judgeTrack, '1k Votes')).toBeTruthy();
    expect(judgeTrack?.textContent).toContain('Crucible votes640 cast');
    expect(tile(el, '500 Votes')?.dataset.state).toBe('earned');
    expect(tile(el, '1k Votes')?.dataset.state).toBe('progress');
    expect(tile(el, '1k Votes')?.textContent).toContain('640 / 1,000');
    expect(tile(el, '5k Votes')?.textContent).toContain('5,000 votes');
  });
});

describe('Compete track', () => {
  it('shows wins against each rung, under its own header, linked to the challenges', () => {
    const el = render(new Map([['compete:wins-1', null]]), 87, 3, 0, 0, 3, {
      challenges: 2,
      crucibles: 1,
    });
    const header = [...el.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Compete'
    );
    const competeTrack = header?.parentElement;
    expect(competeTrack && tile(competeTrack, '5 Wins')).toBeTruthy();
    // A bare total read as an unexplained number; the split says what counts.
    expect(competeTrack?.textContent).toContain('Wins2 challenge wins · 1 Crucible win');
    expect(tile(el, 'First Win')?.dataset.state).toBe('earned');
    expect(tile(el, '5 Wins')?.dataset.state).toBe('progress');
    expect(tile(el, '5 Wins')?.textContent).toContain('3 / 5');
    expect(tile(el, '10 Wins')?.textContent).toContain('10 wins');
    expect(measureHref('wins')).toBe('/challenges');
  });
});

describe('Achievements badge art', () => {
  it('shows the milestone art once it has some, the numbered hex until then', () => {
    const withArt = [{ ...definitions[0], cosmetic: { data: { url: 'first-model-art' } } }];
    const activity = {
      ...buildActivityProgress(withArt, new Map([['create:models-1', null]]), {
        models: 3,
        articles: 0,
        downloads: 0,
        followers: 0,
        reactions: 0,
        revenue: 0,
        votes: 0,
        wins: 0,
      }),
      winBreakdown: { challenges: 0, crucibles: 0 },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(CreatorAchievements, { activity })
        )
      )
    );
    const art = tile(container, 'First Model')?.querySelector('img');
    expect(art?.getAttribute('src')).toContain('first-model-art');

    act(() => root?.unmount());
    container.remove();
    const plain = render(new Map([['create:models-1', null]]));
    expect(tile(plain, 'First Model')?.querySelector('img')).toBeNull();
    expect(tile(plain, 'First Model')?.textContent).toContain('1First Model');
  });
});

// Ladders have five rungs. With the label in a column beside four tiles per row, the fifth wrapped
// onto a line of its own (Ellie's review, 2026-10-09); the label now heads the row instead.
describe('Ladder row layout', () => {
  it('puts the label above the tiles and fits five tiles on a desktop row', () => {
    const el = render(new Map([['create:models-1', null]]));
    const grid = tile(el, 'First Model')?.parentElement;
    expect(grid?.className.split(' ')).toContain('md:grid-cols-5');
    const row = grid?.parentElement;
    expect(row?.firstElementChild?.textContent).toBe('Models3 published');
    expect(row?.className.split(' ')).toContain('flex-col');
  });
});

describe('Artless milestone hexagon', () => {
  it('is a regular hexagon, √3/2 as wide as it is tall, not a square box', () => {
    const el = render(new Map([['create:models-1', null]]));
    const hex = tile(el, 'First Model')?.querySelector<HTMLElement>('[aria-hidden]');
    expect({ width: hex?.style.width, height: hex?.style.height }).toEqual({
      width: '42px',
      height: '48px',
    });
  });
});

// Truncating cut off the badge name, which is the point of the tile (lead review, 2026-10-09).
describe('Ladder tile names', () => {
  it('wraps a long name onto a second line instead of truncating it', () => {
    const el = render(new Map([['create:models-1', null]]));
    const name = [...(tile(el, '25 Models')?.querySelectorAll<HTMLElement>('*') ?? [])].find(
      (node) => node.textContent === '25 Models'
    );
    expect(name?.className).not.toMatch(/truncate/);
    expect(name?.getAttribute('data-line-clamp')).toBe('true');
    expect(name?.style.getPropertyValue('--text-line-clamp')).toBe('2');
  });
});
