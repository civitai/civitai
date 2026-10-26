// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type { UserMenuRegistry } from './resolveUserMenu';

/**
 * The header's Create dropdown is disabled below `md`, so the phone menu is the only way to the
 * create pages other than Generate. Visibility is the dropdown's own `useGetActionMenuItems` flags.
 */
const state = vi.hoisted(() => ({
  user: { id: 1, username: 'tester', muted: false } as { id: number; muted: boolean } | null,
  flags: {} as Record<string, boolean>,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => state.user,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => state.flags,
}));

const { useGetActionMenuItems } = await import('~/components/AppLayout/AppHeader/hooks');
const { resolveUserMenu } = await import('./resolveUserMenu');
const { getUserMenuLayout, USER_MENU_LAYOUT, USER_MENU_SIGNED_OUT_LAYOUT } = await import(
  './user-menu.layout'
);

const ALL_FLAGS = {
  canWrite: true,
  model3dGenerator: true,
  imageTraining: true,
  articles: true,
  comicCreator: true,
  bounties: true,
  challengePlatform: true,
  userChallenges: true,
};

let actionItems: ReturnType<typeof useGetActionMenuItems> = [];
let root: Root;
function Harness() {
  actionItems = useGetActionMenuItems();
  return null;
}
function resolve({ mobile }: { mobile: boolean }) {
  act(() => {
    root = createRoot(document.createElement('div'));
    root.render(createElement(MantineProvider, null, createElement(Harness)));
  });
  const registry: UserMenuRegistry = {};
  for (const item of actionItems) if (item.id) registry[item.id] = item;
  return resolveUserMenu(getUserMenuLayout({ signedIn: !!state.user, mobile }), registry, []).nodes;
}
const createGroup = (nodes: ReturnType<typeof resolve>) =>
  nodes.find((node) => node.kind === 'group' && node.id === 'create');
const labels = (nodes: ReturnType<typeof resolve>) => {
  const group = createGroup(nodes);
  return group?.kind === 'group'
    ? group.children.map((child) => (child.kind === 'item' ? child.item.label.trim() : child.id))
    : [];
};

afterEach(() => {
  act(() => root?.unmount());
  state.user = { id: 1, username: 'tester', muted: false } as typeof state.user;
  state.flags = {};
});

describe('Create group in the phone menu', () => {
  it('leads the phone menu with every desktop Create entry the viewer can open', () => {
    state.flags = ALL_FLAGS;
    const nodes = resolve({ mobile: true });
    expect(nodes[0]).toMatchObject({ kind: 'group', id: 'create' });
    expect(labels(nodes)).toEqual(
      actionItems.filter((item) => item.visible).map((item) => item.label.trim())
    );
    expect(labels(nodes)).toEqual([
      'Generate',
      'Post Images',
      'Post Videos',
      'Upload a Model',
      'Generate 3D Model',
      'Train a LoRA',
      'Write an Article',
      'Create a Comic',
      'Create a Bounty',
      'Create a Challenge',
    ]);
  });

  it('drops an entry whose flag is off, as the desktop dropdown does', () => {
    state.flags = { ...ALL_FLAGS, bounties: false };
    expect(labels(resolve({ mobile: true }))).not.toContain('Create a Bounty');
  });

  it('shows a muted viewer no Create group', () => {
    state.flags = ALL_FLAGS;
    state.user = { id: 1, username: 'tester', muted: true } as typeof state.user;
    expect(createGroup(resolve({ mobile: true }))).toBeUndefined();
  });

  it('shows signed-out phones the group, each create page behind a login prompt', () => {
    state.flags = ALL_FLAGS;
    state.user = null;
    const group = createGroup(resolve({ mobile: true }));
    expect(group?.kind === 'group' && group.children.length).toBeGreaterThan(0);
    const postImages = actionItems.find((item) => item.href === '/posts/create');
    expect(postImages?.redirectReason).toBe('post-images');
  });

  it('leaves the desktop menu as it was: Create stays in the header dropdown', () => {
    state.flags = ALL_FLAGS;
    expect(getUserMenuLayout({ signedIn: true, mobile: false })).toBe(USER_MENU_LAYOUT);
    expect(getUserMenuLayout({ signedIn: false, mobile: false })).toBe(USER_MENU_SIGNED_OUT_LAYOUT);
    expect(createGroup(resolve({ mobile: false }))).toBeUndefined();
  });
});
