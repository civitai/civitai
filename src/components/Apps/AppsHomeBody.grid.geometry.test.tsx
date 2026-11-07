/**
 * `/apps` "My apps" — the tile grid packs from the left at a fixed tile width.
 *
 * What a viewer would notice: two apps stretched across the page, hundreds of pixels apart,
 * because each tile took an equal share of the row. This renders the real `AppsHomeBody` and
 * measures boxes, in the `geometry` project because the grid is a Tailwind utility and the
 * `component` tier does not load Tailwind (the harness asserts the cascade arrived first, so a
 * missing stylesheet fails the run instead of reproducing the defect's numbers).
 *
 * The page gutter is modelled as 16px of padding on each side, as the apps container has.
 */
import { describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import {
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  cascadeEvidence,
  renderAtViewport,
} from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';

const mocks = vi.hoisted(() => ({ apps: [] as unknown[] }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 41, username: 'v' }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy(
    {
      'appListings.listMyApps': {
        useQuery: () => ({
          data: { apps: mocks.apps },
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      'appListings.hideMyApp': { useMutation: () => ({ mutateAsync: vi.fn() }) },
      'appListings.unhideMyApp': { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    { useUtils: () => ({ appListings: { listMyApps: { invalidate: vi.fn() } } }) }
  ),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({}),
  useOptionalFeatureFlags: () => ({}),
}));

const { AppsHomeBody } = await import('./AppsHomeBody');

const app = (n: number): MyAppRow => ({
  listingId: `apl_${n}`,
  slug: `app-${n}`,
  name: `App ${n}`,
  category: null,
  iconUrl: null,
  coverUrl: null,
  kind: 'page',
  launchHref: `/apps/run/app-${n}`,
  external: false,
  lastUsedAt: new Date(`2026-10-${10 + n}T00:00:00.000Z`),
});

const DESKTOP = { width: 1280, height: 900 } as const;

async function tilesAt(viewport: { width: number; height: number }, count: number) {
  mocks.apps = Array.from({ length: count }, (_, i) => app(i + 1));
  await renderAtViewport(
    <div style={{ padding: '0 16px' }}>
      <AppsHomeBody />
    </div>,
    viewport
  );
  const grid = document.querySelector('[data-testid="apps-home-grid"]') as HTMLElement;
  const tiles = [...document.querySelectorAll('[data-testid="apps-home-tile"]')].map((t) =>
    t.getBoundingClientRect()
  );
  return { grid: grid.getBoundingClientRect(), tiles, doc: document.documentElement };
}

describe('My apps grid', () => {
  test('the harness is measuring the real cascade', async () => {
    await renderAtViewport(<div data-testid="probe" />, DESKTOP);
    const evidence = cascadeEvidence();
    expect(evidence.ruleCount).toBeGreaterThan(2000);
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);
    cleanup();
  });

  test('two apps on a desktop sit side by side at the left', async () => {
    const { grid, tiles } = await tilesAt(DESKTOP, 2);
    expect(tiles).toHaveLength(2);
    expect(tiles[0].left).toBe(grid.left);
    expect(tiles[0].width).toBe(104);
    const gap = tiles[1].left - tiles[0].right;
    expect(gap).toBe(20);
    cleanup();
  });

  test('a phone gets 96px tiles, three per row at 360 wide, with no sideways scroll', async () => {
    for (const vp of [NARROW_PHONE_VIEWPORT, PHONE_VIEWPORT]) {
      const { tiles, doc } = await tilesAt(vp, 7);
      expect(tiles[0].width).toBe(96);
      expect(tiles[1].left - tiles[0].right).toBe(16);
      expect(tiles[3].top - tiles[0].bottom).toBeGreaterThanOrEqual(24);
      expect(tiles.filter((t) => t.top === tiles[0].top)).toHaveLength(3);
      expect(doc.scrollWidth).toBeLessThanOrEqual(vp.width);
      cleanup();
    }
  });

  test('the tile width steps at the sm breakpoint, not before or after', async () => {
    for (const [width, tile] of [
      [700, 96],
      [800, 104],
    ] as const) {
      const { tiles } = await tilesAt({ width, height: 900 }, 2);
      expect(tiles[0].width).toBe(tile);
      cleanup();
    }
  });

  test('a long name stays on one ellipsised line inside its tile and the ⋮ stays reachable', async () => {
    const LONG = 'Pixel Forge Ultra Deluxe Background Remover And Upscaler Studio';
    mocks.apps = [{ ...app(1), name: LONG }];
    await renderAtViewport(
      <div style={{ padding: '0 16px' }}>
        <AppsHomeBody />
      </div>,
      NARROW_PHONE_VIEWPORT
    );
    const name = document.querySelector('[data-testid="apps-home-tile-name"]') as HTMLElement;
    const css = getComputedStyle(name);
    expect(css.whiteSpace).toBe('nowrap');
    expect(css.textOverflow).toBe('ellipsis');
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    const tile = document.querySelector('[data-testid="apps-home-tile"]') as HTMLElement;
    expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
      tile.getBoundingClientRect().right + 0.5
    );
    expect(document.querySelectorAll('[data-testid="apps-home-tile-menu"]')).toHaveLength(1);
    cleanup();
  });
});
