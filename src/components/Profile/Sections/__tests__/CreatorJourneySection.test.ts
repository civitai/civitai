// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

const achievement = (n: number) => ({
  key: `create:models-${n}`,
  track: 'create',
  name: `${n} Models`,
  description: null,
  badgeUrl: null,
  achievedAt: null,
});
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
    mocks.achievements = [1, 5, 10, 25, 50, 100].map(achievement);
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
    expect(grid?.className.split(' ')).toEqual(
      expect.arrayContaining(['@[480px]:grid-cols-3', '@[760px]:grid-cols-5'])
    );
    expect(heading?.parentElement?.className.split(' ')).toContain('@container');
  });
});
