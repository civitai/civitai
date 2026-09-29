import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  boundAppBlockIdLabel,
  isConfirmedNonApprovedAppBlockId,
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

/**
 * 🔴 `isConfirmedNonApprovedAppBlockId` IS NOT THE NEGATION OF `isKnownAppBlockId`, and
 * the difference only shows up in the failure case — which is exactly where a consumer
 * using the negation as a cheap pre-filter would escalate every request into expensive
 * work against a database that has just stopped answering. These two cases are the whole
 * reason the export exists; without them, deleting `trusted &&` from its body is a
 * change no test can see.
 */
describe('isConfirmedNonApprovedAppBlockId [INV]', () => {
  it('answers TRUE for an id outside a successfully-read approved set', async () => {
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(true);
  });

  it('answers FALSE for an approved id — and agrees with isKnownAppBlockId when trusted', async () => {
    expect(await isConfirmedNonApprovedAppBlockId('apb_known_1')).toBe(false);
    // The two forms coincide on the happy path. That coincidence is what makes the
    // failure case below the only discriminating measurement.
    expect(await isKnownAppBlockId('apb_known_1')).toBe(true);
  });

  it('🔴 answers FALSE FOR EVERYTHING while the set is UNTRUSTED, where the negation says TRUE', async () => {
    mockFindMany.mockRejectedValue(new Error('engine down'));
    // The negation's answer, measured rather than asserted from the docblock: with the
    // load failed, an approved app looks unknown.
    expect(await isKnownAppBlockId('apb_known_1')).toBe(false);
    // The confirmed form refuses to turn that into a claim about the app.
    expect(await isConfirmedNonApprovedAppBlockId('apb_known_1')).toBe(false);
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
  });

  it('stays FALSE for the whole cached failure window, not just the first call', async () => {
    // A failed load is cached for the TTL. If `trusted` were recomputed per call rather
    // than stored on the entry, the second call inside the window would read a stale
    // `true` off the cache and the amplification would return after one request.
    mockFindMany.mockRejectedValue(new Error('engine down'));
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
