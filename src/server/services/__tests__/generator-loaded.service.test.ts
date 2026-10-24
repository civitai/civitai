import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ResourceData from '~/server/redis/resource-data.redis';
import type * as ResourceResidency from '~/server/services/resource-residency.service';

const { bust, bustResidency } = vi.hoisted(() => ({
  bust: vi.fn(async () => undefined),
  bustResidency: vi.fn(async () => undefined),
}));

vi.mock('~/server/redis/resource-data.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceData>()),
  resourceDataCache: { bust },
}));
vi.mock('~/server/services/resource-residency.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceResidency>()),
  bustResourceResidency: bustResidency,
}));

import {
  bustGeneratorLoadedCaches,
  setGeneratorLoaded,
} from '~/server/services/generator-loaded.service';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockImplementation(async () => 2);
});

describe('setGeneratorLoaded', () => {
  it('writes in batches and reports every row it updated', async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => i + 1);

    await expect(setGeneratorLoaded(ids, true)).resolves.toBe(4);
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('writes nothing for an empty list', async () => {
    await expect(setGeneratorLoaded([], false)).resolves.toBe(0);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('bustGeneratorLoadedCaches', () => {
  it('clears both caches that serve residency', async () => {
    await bustGeneratorLoadedCaches([1, 2]);

    expect(bust).toHaveBeenCalledWith([1, 2]);
    expect(bustResidency).toHaveBeenCalledWith([1, 2]);
  });

  it('touches neither cache for an empty list', async () => {
    await bustGeneratorLoadedCaches([]);

    expect(bust).not.toHaveBeenCalled();
    expect(bustResidency).not.toHaveBeenCalled();
  });
});
