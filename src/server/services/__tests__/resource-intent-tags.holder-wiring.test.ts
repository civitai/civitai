import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The process holder as the app wires it (`tagIndexSnapshotHolder()`), with its collaborators
 * replaced by spies. With the holder flag off nothing of the index is touched: no Flipt-gated
 * database read, no object store, and neither the spec-hash module (which computes over fixtures
 * when it loads) nor the decode worker's module is even imported. With it on, the same wiring does
 * read (the positive control: the spies can see a load path).
 */

const spies = vi.hoisted(() => ({
  isFlipt: vi.fn(),
  queryRaw: vi.fn(async () => [] as unknown[]),
  executeRaw: vi.fn(async () => 0),
  s3Objects: vi.fn(),
  specImported: vi.fn(),
  decodeWorkerImported: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: spies.isFlipt,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: spies.queryRaw, $executeRaw: spies.executeRaw },
  dbWrite: { $queryRaw: spies.queryRaw, $executeRaw: spies.executeRaw },
}));
vi.mock('~/server/services/resource-intent-tags/objects', () => ({
  s3TagIndexObjects: spies.s3Objects,
}));
vi.mock('~/server/services/resource-intent-tags/spec', () => {
  spies.specImported();
  return { RESOURCE_INTENT_TAGS_SPEC_HASH: 'd'.repeat(64) };
});
vi.mock('~/server/services/resource-intent-tags/decode-worker', () => {
  spies.decodeWorkerImported();
  return { decodeTagIndexInWorker: vi.fn() };
});

import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

describe('tagIndexSnapshotHolder() wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('with the flag off, reads the flag and nothing else, every time', async () => {
    spies.isFlipt.mockResolvedValue(false);
    const { tagIndexSnapshotHolder } = await import(
      '~/server/services/resource-intent-tags/holder'
    );
    const holder = tagIndexSnapshotHolder();
    for (let i = 0; i < 3; i++)
      expect(await holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'disabled' });
    expect(spies.isFlipt).toHaveBeenCalledTimes(3);
    expect(spies.isFlipt).toHaveBeenCalledWith(
      FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_HOLDER
    );
    expect(spies.queryRaw).not.toHaveBeenCalled();
    expect(spies.s3Objects).not.toHaveBeenCalled();
    expect(spies.specImported).not.toHaveBeenCalled();
    expect(spies.decodeWorkerImported).not.toHaveBeenCalled();
  });

  it('with the flag on, the same wiring reads the newest ready row (positive control)', async () => {
    spies.isFlipt.mockResolvedValue(true);
    const { tagIndexSnapshotHolder } = await import(
      '~/server/services/resource-intent-tags/holder'
    );
    expect(await tagIndexSnapshotHolder().resolve()).toEqual({
      snapshot: null,
      fallbackReason: 'no_snapshot',
    });
    expect(spies.specImported).toHaveBeenCalled();
    expect(spies.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('its flag is the default-off key the doc names', () => {
    expect(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_HOLDER).toBe(
      'resource-intent-tag-index-holder'
    );
  });
});
