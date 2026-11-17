import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The seam the unit tests of `readCatalog` cannot see: that the REAL scope read is the
 * public-catalog decision, kill switch included. Replacing it with the constant scope (`full`)
 * passes every other test in this directory; it fails here.
 */

const { isFliptMock } = vi.hoisted(() => ({ isFliptMock: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));

import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import { PUBLIC_APPS_CATALOG_DISABLED_FLAG } from '~/server/services/blocks/public-apps-catalog';

describe('liveCatalogReadDeps().resolveScope', () => {
  beforeEach(() => isFliptMock.mockReset());

  it('🔴 the kill switch thrown → `none`', async () => {
    isFliptMock.mockImplementation(
      async (flag: string) => flag === PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
    expect(await liveCatalogReadDeps().resolveScope()).toBe('none');
  });

  it('positive control: the kill switch off → the public catalog, and the switch was read', async () => {
    isFliptMock.mockResolvedValue(false);
    expect(await liveCatalogReadDeps().resolveScope()).toBe('full');
    expect(isFliptMock.mock.calls.map(([flag]) => flag)).toContain(
      PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
  });
});
