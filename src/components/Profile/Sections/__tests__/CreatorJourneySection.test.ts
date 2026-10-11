// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

const achievement = (n: number, achievedAt: Date | null = null, track = 'create') => ({
  key: `${track}:${track === 'create' ? 'models' : 'followers'}-${n}`,
  track,
  name: `${n} ${track === 'create' ? 'Models' : 'Followers'}`,
  description: null,
  badgeUrl: null,
  achievedAt,
});
const daysAgo = (days: number) => new Date(Date.UTC(2026, 9, 10 - days));
const mocks = vi.hoisted(() => ({ achievements: [] as unknown[] }));
vi.mock('~/components/CreatorJourney/useProfileAchievements', () => ({
  useProfileAchievements: () => ({
    data: { tiers: [], achievements: mocks.achievements },
    count: mocks.achievements.length,
    isLoading: false,
  }),
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

import { CreatorJourneySection } from '~/components/Profile/Sections/CreatorJourneySection';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

// Ellie's review (2026-10-09): three cards a row was too wide on desktop. The row sizes on its own
// width, since the profile sidebar takes 320px of the viewport.
describe('profile Creator Journey section', () => {
  it('shows the latest five achievements, five across once the row is wide enough', () => {
    mocks.achievements = [1, 5, 10, 25, 50, 100].map((n, index) => achievement(n, daysAgo(index)));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const user = { id: 7, username: 'maker' } as ProfileSectionProps['user'];
    act(() =>
      root?.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(CreatorJourneySection, { user })
        )
      )
    );

    const heading = [...container.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Latest achievements'
    );
    const grid = heading?.nextElementSibling as HTMLElement | undefined;
    expect(grid?.children).toHaveLength(5);
    // The newest five.
    expect(grid?.textContent).toContain('50 Models');
    expect(grid?.textContent).not.toContain('100 Models');
    expect(grid?.className.split(' ')).toEqual(
      expect.arrayContaining(['@[480px]:grid-cols-3', '@[760px]:grid-cols-5'])
    );
    expect(heading?.parentElement?.className.split(' ')).toContain('@container');
  });

  // Justin's call (2026-10-10): dated badges newest first, then the ones granted at launch, best
  // first across tracks. Before this, launch grants carried the backfill run's time and led the row.
  it('leads with dated badges, then launch grants best first, whatever the track', () => {
    mocks.achievements = [
      achievement(1),
      achievement(10000, null, 'reach'),
      achievement(5, daysAgo(3)),
      achievement(100),
      achievement(500, daysAgo(1)),
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const user = { id: 7, username: 'maker' } as ProfileSectionProps['user'];
    act(() =>
      root?.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(CreatorJourneySection, { user })
        )
      )
    );
    const heading = [...container.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.childElementCount === 0 && node.textContent === 'Latest achievements'
    );
    const names = [
      ...((heading?.nextElementSibling as HTMLElement).children as HTMLCollection),
    ].map((card) =>
      ['500 Models', '5 Models', '10000 Followers', '100 Models', '1 Models'].find((name) =>
        [...card.querySelectorAll('*')].some((node) => node.textContent === name)
      )
    );
    // 10,000 followers is that ladder's diamond; 100 models is gold; one model is wood.
    expect(names).toEqual(['500 Models', '5 Models', '10000 Followers', '100 Models', '1 Models']);
  });
});
