import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  boundAppBlockIdLabel,
  isKnownAppBlockId,
  _internalsForTests,
} from '../known-app-blocks.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindMany = dbMock.dbRead.appBlock.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  _internalsForTests.reset();
  mockFindMany.mockResolvedValue([{ id: 'apb_known_1' }, { id: 'apb_known_2' }]);
});

describe('known-app-blocks.service', () => {
  it('preserves an approved app id and buckets an unknown one to "other"', async () => {
    expect(await boundAppBlockIdLabel('apb_known_1')).toBe('apb_known_1');
    expect(await boundAppBlockIdLabel('apb_attacker_garbage')).toBe('other');
    expect(await isKnownAppBlockId('apb_known_2')).toBe(true);
    expect(await isKnownAppBlockId('apb_nope')).toBe(false);
  });

  it('queries only status:"approved"', async () => {
    await isKnownAppBlockId('apb_known_1');
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { status: 'approved' },
      select: { id: true },
    });
  });

  it('TTL-caches — a second lookup in the window does not re-query the DB', async () => {
    await isKnownAppBlockId('apb_known_1');
    await isKnownAppBlockId('apb_known_2');
    await boundAppBlockIdLabel('apb_known_1');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('fails SAFE on a DB error — unknown set, everything buckets to "other"', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('engine down'));
    expect(await boundAppBlockIdLabel('apb_known_1')).toBe('other');
  });
});
