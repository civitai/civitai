import { describe, expect, it } from 'vitest';
import type { NavLink } from '$lib/server/access';
import {
  initialDashboardView,
  navOwnedBy,
  ownableQueues,
  retiredQueuePaths,
  unownedQueues,
} from '../queue-owners';

const NAV: NavLink[] = [
  { path: '/', label: 'Dashboard' },
  {
    label: 'Images',
    children: [
      { path: '/images/a', label: 'A', countKey: 'a' },
      { path: '/images/tool', label: 'Uncounted tool' },
      { path: '/images/stuck', label: 'Stuck', countKey: 'stuck', informational: true },
      { path: '/reports/image', label: 'Image Reports', countKey: 'ri', shortcut: true },
      {
        path: '/images/flags',
        label: 'Flags',
        tabs: true,
        children: [
          { path: '/images/flags/one', label: 'One', countKey: 'f1' },
          { path: '/images/flags/two', label: 'Two', countKey: 'f2' },
        ],
      },
    ],
  },
  { label: 'Reports', children: [{ path: '/reports/image', label: 'Images', countKey: 'ri' }] },
  { path: '/strikes', label: 'Strikes', countKey: 'strikes' },
  { path: 'https://example.com', label: 'Elsewhere', countKey: 'x', external: true },
  { path: '/admin', label: 'Permissions' },
];

describe('ownableQueues', () => {
  it('lists counted leaves, tab pages included, each once under its top-level section', () => {
    expect(ownableQueues(NAV)).toEqual([
      { path: '/images/a', label: 'A', section: 'Images' },
      { path: '/images/flags/one', label: 'One', section: 'Images' },
      { path: '/images/flags/two', label: 'Two', section: 'Images' },
      { path: '/reports/image', label: 'Images', section: 'Reports' },
      { path: '/strikes', label: 'Strikes', section: 'Pages' },
    ]);
  });
});

describe('navOwnedBy', () => {
  const paths = (nav: NavLink[]): string[] =>
    nav.flatMap((l) => (l.children ? paths(l.children) : l.path ? [l.path] : []));

  it('keeps only owned queues, and a group only while something under it is owned', () => {
    const owned = navOwnedBy(NAV, new Set(['/strikes', '/images/flags/two']));
    expect(paths(owned)).toEqual(['/images/flags/two', '/strikes']);
    expect(owned.map((l) => l.label)).toEqual(['Images', 'Strikes']);
  });

  it('narrows a tabs group to its owned tabs, so it counts and opens on those alone', () => {
    const images = navOwnedBy(NAV, new Set(['/images/flags/two']))[0];
    const flags = images.children?.[0];
    expect(flags?.tabs).toBe(true);
    expect(flags?.children?.map((c) => c.path)).toEqual(['/images/flags/two']);
  });

  it('owns nothing → shows nothing', () => {
    expect(navOwnedBy(NAV, new Set())).toEqual([]);
  });
});

describe('unownedQueues / retiredQueuePaths', () => {
  const queues = ownableQueues(NAV);

  it('a queue with no owner rows, or an empty list, is unowned', () => {
    const unowned = unownedQueues(queues, { '/images/a': [3], '/strikes': [] });
    expect(unowned.map((q) => q.path)).toEqual([
      '/images/flags/one',
      '/images/flags/two',
      '/reports/image',
      '/strikes',
    ]);
  });

  it('owners on a path that is no longer a queue are retired, not counted as coverage', () => {
    const owners = { '/images/a': [3], '/images/renamed': [4], '/images/tool': [5] };
    expect(retiredQueuePaths(queues, owners)).toEqual(['/images/renamed', '/images/tool']);
  });
});

describe('initialDashboardView', () => {
  it('opens on My tasks for an owner, and remembers a switch to Everything', () => {
    expect(initialDashboardView(['/strikes'], null)).toBe('mine');
    expect(initialDashboardView(['/strikes'], 'all')).toBe('all');
    expect(initialDashboardView(['/strikes'], 'mine')).toBe('mine');
  });

  it('opens on Everything when there is nothing to own or ownership could not be read', () => {
    expect(initialDashboardView([], 'mine')).toBe('all');
    expect(initialDashboardView(null, 'mine')).toBe('all');
  });
});
