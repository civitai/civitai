// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorAchievements } from '~/components/CreatorJourney/CreatorAchievements';
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
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(held: Map<string, Date | null>, followers = 87) {
  const activity = buildActivityProgress(definitions, held, {
    models: 3,
    articles: 0,
    downloads: 0,
    followers,
    reactions: 0,
  });
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

const tile = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('[data-state]')].find((t) => t.textContent?.includes(name));

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

  // Reached but not granted yet (the job runs nightly): neither earned nor the next target.
  it('does not show an ungranted milestone as earned', () => {
    const el = render(new Map(), 150);
    expect(tile(el, '100 Followers')?.dataset.state).toBe('locked');
    expect(tile(el, '1k Followers')?.dataset.state).toBe('progress');
  });
});

describe('Achievements badge art', () => {
  it('shows the milestone art once it has some, the numbered hex until then', () => {
    const withArt = [{ ...definitions[0], cosmetic: { data: { url: 'first-model-art' } } }];
    const activity = buildActivityProgress(withArt, new Map([['create:models-1', null]]), {
      models: 3,
      articles: 0,
      downloads: 0,
      followers: 0,
      reactions: 0,
    });
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
