import { Menu } from '@mantine/core';
import { IconBookmark } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, nextLayout, renderAtViewport } from '../../../../../test/geometry-setup';
import type * as TrackUtils from '~/components/TrackView/track.utils';
import type { ResolvedMenuNode } from './resolveUserMenu';

/**
 * The "Your stuff" flyout opens to the left of the 260px dropdown. Its rows carry a label, the
 * "99+" count and the mute and pin buttons, and none of them may wrap. Real cascade; only the
 * session and the tracking transport are stubbed.
 */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  trackAction: () => ({ catch: () => undefined }),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));

const { UserMenuCtx } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { BadgeMuteCtx } = await import('./UserMenuParts');
const { DesktopNodes } = await import('./UserMenuDesktop');

afterEach(cleanup);

const row = (id: 'collections' | 'inventory', label: string, badge?: number) =>
  ({
    kind: 'item',
    item: { id, label, icon: IconBookmark, href: `/${id}`, badge },
  } as ResolvedMenuNode);

const nodes: ResolvedMenuNode[] = [
  {
    kind: 'group',
    id: 'your-stuff',
    label: 'Your Stuff',
    icon: IconBookmark,
    badge: 120,
    children: [row('collections', 'My Collections', 120), row('inventory', 'Inventory')],
  },
];
const pins = { pins: [], canEdit: true, toggle: vi.fn(), move: vi.fn() } as never;

async function openFlyout(width: number) {
  await renderAtViewport(
    createElement(
      UserMenuCtx.Provider,
      { value: { handleClose: () => undefined } },
      createElement(
        BadgeMuteCtx.Provider,
        { value: () => undefined },
        <div style={{ marginLeft: width - 300 }}>
          <Menu opened withinPortal={false} width={260} position="bottom-end">
            <Menu.Target>
              <button>open</button>
            </Menu.Target>
            <Menu.Dropdown>
              <DesktopNodes nodes={nodes} pins={pins} onToggle={() => undefined} />
            </Menu.Dropdown>
          </Menu>
        </div>
      )
    ),
    { width, height: 800 }
  );
  const group = document.querySelector<HTMLElement>(
    'button[aria-haspopup="menu"][data-menu-item]'
  )!;
  group.focus();
  group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('a[href="/collections"]')).not.toBeNull());
  await nextLayout();
}

describe('the "Your stuff" flyout', () => {
  test.each([1280, 1440])('draws a row with a 99+ count on one line at %ipx', async (width) => {
    await openFlyout(width);
    const link = document.querySelector('a[href="/collections"]')!;
    const label = link.querySelector('.mantine-Menu-itemLabel')!;
    const text = [...label.querySelectorAll('span')].find(
      (s) => s.textContent === 'My Collections'
    )!;
    const plain = document.querySelector('a[href="/inventory"]')!;

    // One line of text: the label is no taller than a line, not two stacked words.
    expect(box(text).height, 'label is one line').toBeLessThanOrEqual(20);
    expect(box(link).height, 'rows are the same height').toBeLessThanOrEqual(box(plain).height + 2);
    expect(link.textContent).toContain('99+');
    const dropdown = link.closest('[data-menu-dropdown]')!;
    expect(box(link).right).toBeLessThanOrEqual(box(dropdown).right);
  });
});
