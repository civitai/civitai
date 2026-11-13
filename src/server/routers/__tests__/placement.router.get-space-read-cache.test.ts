import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';

/**
 * `placement.getSpace` serves the display read (`resolvePlacementSpaceForDisplay`, a Redis cache)
 * only when `placement-space-read-cache` is EXACTLY on. `isFliptSync` answers `null` when Flipt
 * cannot answer (an unknown key, an uninitialized client); that must keep the primary read, the
 * same as off.
 */

const { flag, primaryRead, displayRead } = vi.hoisted(() => ({
  flag: { value: null as boolean | null },
  // Distinct answers, so the response names the path that served it.
  primaryRead: vi.fn(async () => ({ served: 'primary' })),
  displayRead: vi.fn(async () => ({ served: 'display' })),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  // Literal key, not the enum: a renamed flag must fail here, not follow along.
  isFliptSync: (key: string) => (key === 'placement-space-read-cache' ? flag.value : null),
}));
vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: primaryRead,
  resolvePlacementSpaceForDisplay: displayRead,
}));

import { placementCaller } from '~/server/routers/__tests__/placement.router.test-utils';

const INPUT = { surface: 'sticker', targetType: 'image', targetId: 501 } as const;

beforeEach(() => {
  vi.clearAllMocks();
  flag.value = null;
});

describe('placement.getSpace — the read-cache flag', () => {
  it.each([
    [null, 'primary'],
    [false, 'primary'],
    [true, 'display'],
  ] as const)('with the flag %s, serves the %s read', async (value, served) => {
    flag.value = value;
    // A copy: a middleware stamps the request's browsing level onto the input object it is handed.
    await expect(placementCaller().getSpace({ ...INPUT })).resolves.toEqual({ served });

    const [taken, untaken] =
      served === 'display' ? [displayRead, primaryRead] : [primaryRead, displayRead];
    expect(taken).toHaveBeenCalledTimes(1);
    expect(taken).toHaveBeenCalledWith(INPUT);
    expect(untaken).not.toHaveBeenCalled();
  });
});
