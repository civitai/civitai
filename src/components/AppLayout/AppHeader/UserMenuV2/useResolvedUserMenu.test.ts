// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { IconBookmark } from '@tabler/icons-react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type { UserMenuRegistry } from './resolveUserMenu';

/** The hook is the join between the registry, the saved mutes and the resolver; each is stubbed. */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/AppLayout/AppHeader/useEventMenuItems', () => ({
  useEventMenuItems: () => [],
}));
const registry: UserMenuRegistry = {
  collections: { label: 'My Collections', icon: IconBookmark, href: '/c', badge: 4 },
};
vi.mock('./useUserMenuRegistry', () => ({ useUserMenuRegistry: () => registry }));

const { useResolvedUserMenu } = await import('./useResolvedUserMenu');

let latest: ReturnType<typeof useResolvedUserMenu>;
let root: Root;
function Harness({ muted }: { muted: ['collections'] | [] }) {
  latest = useResolvedUserMenu({ opened: true, pins: ['collections'], muted });
  return null;
}
const mount = (muted: ['collections'] | []) =>
  act(() => {
    root = createRoot(document.createElement('div'));
    root.render(createElement(MantineProvider, null, createElement(Harness, { muted })));
  });

afterEach(() => act(() => root.unmount()));

describe('useResolvedUserMenu', () => {
  it('marks the rows of muted counts and leaves the rest counting', () => {
    mount([]);
    expect(latest.pinned[0]).toMatchObject({ badge: 4 });
    expect(latest.pinned[0].badgeMuted).toBeUndefined();

    act(() => root.unmount());
    mount(['collections']);
    expect(latest.pinned[0]).toMatchObject({ badge: 4, badgeMuted: true });
  });
});
