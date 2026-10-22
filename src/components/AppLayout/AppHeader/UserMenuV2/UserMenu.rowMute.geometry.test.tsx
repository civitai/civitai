import { Menu } from '@mantine/core';
import { IconBookmark } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../../../test/geometry-setup';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * A row with a count (up to the "99+" cap), the mute bell and the pin, at the two widths the menu
 * is drawn in: the 382px phone panel and the 260px desktop dropdown. Real cascade; only the session
 * and the tracking transport are stubbed.
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
const { DesktopItem } = await import('./UserMenuDesktop');
const { MobileItem } = await import('./UserMenuMobile');

afterEach(cleanup);

const collections = {
  id: 'collections' as const,
  label: 'My Collections',
  icon: IconBookmark,
  href: '/collections',
  badge: 120,
};

function Harness({ children }: { children: React.ReactNode }) {
  return createElement(
    UserMenuCtx.Provider,
    { value: { handleClose: () => undefined } },
    createElement(BadgeMuteCtx.Provider, { value: () => undefined }, children)
  );
}

/** Every part sits inside the row's own box, on one line, and the controls are not squeezed. */
function expectRowFits(row: Element, parts: Element[], maxHeight: number) {
  const outer = box(row);
  for (const part of parts) {
    const b = box(part);
    expect(b.left, 'part starts inside the row').toBeGreaterThanOrEqual(outer.left);
    expect(b.right, 'part ends inside the row').toBeLessThanOrEqual(outer.right);
  }
  const centres = parts.map((p) => box(p).top + box(p).height / 2);
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(2);
  expect(outer.height, 'the row stays one line tall').toBeLessThanOrEqual(maxHeight);
}

describe('a row with a count, the bell and the pin', () => {
  test('fits the phone panel on one line', async () => {
    await renderAtViewport(
      <Harness>
        <div id="panel" className="p-1" style={{ width: PHONE_VIEWPORT.width }}>
          <MobileItem item={collections} onToggle={() => undefined} />
        </div>
      </Harness>,
      PHONE_VIEWPORT
    );
    const row = document.querySelector('#panel > div')!;
    const parts = [
      row.querySelector('a')!,
      row.querySelector('[aria-label^="Mute the count"]')!,
      row.querySelector('[aria-label^="Pin"]')!,
    ];
    expectRowFits(row, parts, 50);
    // The label keeps its count: "99+", not clipped away by the two buttons.
    expect(row.querySelector('a')!.textContent).toContain('99+');
    expect(box(row.querySelector('a')!).width).toBeGreaterThan(200);
  });

  test('fits the 260px desktop dropdown on one line', async () => {
    await renderAtViewport(
      <Harness>
        <Menu opened withinPortal={false} width={260}>
          <Menu.Target>
            <button>open</button>
          </Menu.Target>
          <Menu.Dropdown>
            <DesktopItem item={collections} onToggle={() => undefined} />
          </Menu.Dropdown>
        </Menu>
      </Harness>,
      { width: 1280, height: 800 }
    );
    const row = document.querySelector('a[href="/collections"]')!;
    const parts = [
      row.querySelector('[title="Mute count"]')!,
      row.querySelector('[title="Pin"]')!,
      row.querySelector('.mantine-Menu-itemLabel')!,
    ];
    expectRowFits(row, parts, 40);
    expect(row.textContent).toContain('99+');
  });
});
