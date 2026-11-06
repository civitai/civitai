import { IconUser } from '@tabler/icons-react';
import { describe, expect, it } from 'vitest';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import { movePin, resolveUserMenu, togglePin, type UserMenuRegistry } from './resolveUserMenu';
import {
  findUserMenuGroup,
  USER_MENU_LAYOUT,
  USER_MENU_MAX_DEPTH,
  USER_MENU_SIGNED_OUT_LAYOUT,
  type UserMenuNode,
} from './user-menu.layout';

const entry = (label: string, extra: Partial<UserMenuItem> = {}): UserMenuItem => ({
  label,
  icon: IconUser,
  href: `/${label}`,
  ...extra,
});

const layout: UserMenuNode[] = [
  {
    kind: 'group',
    id: 'your-stuff',
    label: 'Stuff',
    icon: IconUser,
    children: [
      { kind: 'item', id: 'collections' },
      { kind: 'item', id: 'vault' },
      {
        kind: 'group',
        id: 'help',
        label: 'Deeper',
        icon: IconUser,
        children: [{ kind: 'item', id: 'downloads' }],
      },
    ],
  },
  {
    kind: 'group',
    id: 'rewards',
    label: 'Rewards',
    icon: IconUser,
    children: [{ kind: 'item', id: 'inventory' }],
  },
];

const labels = (nodes: ReturnType<typeof resolveUserMenu>['nodes']): unknown[] =>
  nodes.map((node) =>
    node.kind === 'item' ? node.item.label : { [node.label]: labels(node.children) }
  );

describe('resolveUserMenu', () => {
  it('drops hidden items, and a group left with nothing to open', () => {
    const registry: UserMenuRegistry = {
      collections: entry('collections'),
      vault: entry('vault', { visible: false }),
      downloads: entry('downloads', { visible: false }),
      // `visible` present but undefined hides it, the same as the current menu.
      inventory: entry('inventory', { visible: undefined }),
    };

    expect(labels(resolveUserMenu(layout, registry, []).nodes)).toEqual([
      { Stuff: ['collections'] },
    ]);
  });

  it('gives a group the sum of the counts inside it, nested groups included', () => {
    const registry: UserMenuRegistry = {
      collections: entry('collections', { badge: 2 }),
      vault: entry('vault'),
      downloads: entry('downloads', { badge: 3 }),
      inventory: entry('inventory', { badge: 1 }),
    };

    const { nodes } = resolveUserMenu(layout, registry, []);

    expect(nodes.map((node) => node.kind === 'group' && node.badge)).toEqual([5, 1]);
  });

  it('keeps a muted count on its row and out of the group and pinned totals', () => {
    const registry: UserMenuRegistry = {
      collections: entry('collections', { badge: 2 }),
      vault: entry('vault'),
      downloads: entry('downloads', { badge: 3 }),
      inventory: entry('inventory', { badge: 1 }),
    };

    const { nodes, pinned } = resolveUserMenu(
      layout,
      registry,
      ['collections'],
      new Set(['collections', 'inventory'])
    );

    // Only downloads still counts; the muted rows keep their own number, marked muted.
    expect(nodes.map((node) => node.kind === 'group' && node.badge)).toEqual([3, 0]);
    const collections = pinned[0];
    expect(collections).toMatchObject({ badge: 2, badgeMuted: true });
    const stuff = nodes[0];
    const inGroup = stuff.kind === 'group' && stuff.children[0];
    expect(inGroup && inGroup.kind === 'item' && inGroup.item).toMatchObject({
      badge: 2,
      badgeMuted: true,
    });
  });

  it('lists pins in saved order, skipping hidden, unknown, repeated and unpinnable ids', () => {
    const registry: UserMenuRegistry = {
      collections: entry('collections'),
      vault: entry('vault', { visible: false }),
      inventory: entry('inventory'),
      'sign-in': entry('sign-in'),
    };

    const { pinned } = resolveUserMenu(layout, registry, [
      'inventory',
      'vault',
      'downloads',
      'collections',
      'inventory',
      'sign-in',
    ]);

    expect(pinned.map((item) => item.id)).toEqual(['inventory', 'collections']);
  });
});

describe('pin edits', () => {
  it('toggles a pin on at the end and off again', () => {
    expect(togglePin(['inventory'], 'prizes')).toEqual(['inventory', 'prizes']);
    expect(togglePin(['inventory', 'prizes'], 'inventory')).toEqual(['prizes']);
    expect(togglePin([], 'sign-in')).toEqual([]);
  });

  it('moves a pin onto another one, keeping pins the viewer cannot see in place', () => {
    // `vault` may be hidden for this viewer: it is still in the saved list and must survive.
    expect(
      movePin(['inventory', 'vault', 'prizes', 'collections'], 'collections', 'inventory')
    ).toEqual(['collections', 'inventory', 'vault', 'prizes']);
    expect(movePin(['inventory', 'vault', 'prizes'], 'inventory', 'prizes')).toEqual([
      'vault',
      'prizes',
      'inventory',
    ]);
  });
});

describe('layouts', () => {
  const walk = (nodes: UserMenuNode[], depth: number, ids: string[]): number =>
    Math.max(
      depth,
      ...nodes.map((node) => {
        ids.push(`${node.kind}:${node.id}`);
        return node.kind === 'group' ? walk(node.children, depth + 1, ids) : depth;
      })
    );

  it.each([
    ['signed in', USER_MENU_LAYOUT],
    ['signed out', USER_MENU_SIGNED_OUT_LAYOUT],
  ])('%s: nests at most the allowed depth and places each item once', (_name, nodes) => {
    const ids: string[] = [];
    expect(walk(nodes, 0, ids)).toBeLessThanOrEqual(USER_MENU_MAX_DEPTH);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('moving items between groups', () => {
  it('puts each moved item in its new group', () => {
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'inventory')).toBe('your-stuff');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'auctions')).toBe('creator-tools');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'crucibles')).toBe('rewards');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'browse-challenges')).toBe('rewards');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'civitai-link')).toBe('creator-tools');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'link-app')).toBe('creator-tools');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'buzz-dashboard')).toBe('creator-tools');
    expect(findUserMenuGroup(USER_MENU_LAYOUT, 'getting-started')).toBe('help');
  });

  it('keeps Download Link App last in Creator tools and Getting started first in Get help', () => {
    const childIds = (id: string) => {
      const node = USER_MENU_LAYOUT.find((n) => n.kind === 'group' && n.id === id);
      return node?.kind === 'group' ? node.children.map((c) => c.id) : [];
    };
    expect(childIds('creator-tools').at(-1)).toBe('link-app');
    expect(childIds('help')[0]).toBe('getting-started');
  });

  it('keeps Download Link App in the signed-out menu, which has no Creator tools', () => {
    expect(findUserMenuGroup(USER_MENU_SIGNED_OUT_LAYOUT, 'link-app')).toBeNull();
  });
});
