// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

const mocks = vi.hoisted(() => ({
  viewer: null as { id: number; meta: { scores: { total: number } } } | null,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.viewer,
}));

import type * as CurrentUser from '~/hooks/useCurrentUser';
import {
  AchievementCard,
  ProfileTierCard,
  SECRET_ACHIEVEMENT_LABEL,
} from '~/components/CreatorJourney/ProfileAchievements';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = 7;
const EARNED = new Date('2026-09-28T12:00:00Z');

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(MantineProvider, null, element)));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mocks.viewer = null;
});

describe('profile achievement cards', () => {
  // The server sends a visitor an earned secret with no name; the card must still say what it is.
  it('labels a secret achievement and shows nothing about it but the date', () => {
    const card = mount(
      React.createElement(AchievementCard, {
        achievement: {
          key: 'secret:0',
          track: 'secret',
          name: null,
          description: null,
          badgeUrl: null,
          achievedAt: EARNED,
        },
      })
    );
    expect(SECRET_ACHIEVEMENT_LABEL).toBe('Secret achievement');
    expect(card.textContent).toContain('Secret achievement');
    expect(card.textContent).not.toContain('Creator Score');
  });

  it('shows a named achievement with its description', () => {
    const card = mount(
      React.createElement(AchievementCard, {
        achievement: {
          key: 'create:models-25',
          track: 'create',
          name: '25 Models',
          description: 'Publish 25 models',
          badgeUrl: null,
          achievedAt: EARNED,
        },
      })
    );
    expect(card.textContent).toContain('25 Models');
    expect(card.textContent).toContain('Publish 25 models');
  });
});

describe('profile tier card', () => {
  const tier = { key: 'score:star', name: 'Star', badgeUrl: null, achievedAt: EARNED };
  const OWN_SCORE = 824228;

  it('shows the owner their own score', () => {
    mocks.viewer = { id: OWNER, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(card.textContent).toContain('Only you see this');
    expect(card.textContent).toContain('824,228');
  });

  // A signed-in visitor's session carries their own score, never the owner's; showing it here
  // would read as the owner's number.
  it('shows a visitor the tier and no score line', () => {
    mocks.viewer = { id: OWNER + 1, meta: { scores: { total: OWN_SCORE } } };
    const card = mount(React.createElement(ProfileTierCard, { tier, userId: OWNER }));
    expect(card.textContent).toContain('Star');
    expect(card.textContent).not.toContain('Only you see this');
    expect(card.textContent).not.toContain('824,228');
  });
});
