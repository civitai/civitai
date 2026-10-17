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
  s3Objects: vi.fn(),
  specImported: vi.fn(),
  decodeWorkerImported: vi.fn(),
  decodeInWorker: vi.fn(async () => {
    throw new Error('not decoded in this test');
  }),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: spies.isFlipt,
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
  return { decodeTagIndexInWorker: spies.decodeInWorker };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

// The canonical db mock (installed by the test setup): the holder reads through dbRead.
const queryRaw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;

describe('tagIndexSnapshotHolder() wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queryRaw.mockReset();
    queryRaw.mockImplementation(async () => []);
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
    expect(queryRaw).not.toHaveBeenCalled();
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
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('with the flag on and a ready row, the wiring downloads and decodes on the worker (positive control)', async () => {
    spies.isFlipt.mockResolvedValue(true);
    const sha = 'c'.repeat(64);
    queryRaw.mockImplementation(async (q: unknown) =>
      /ResourceIntentVocabulary/.test((q as { text: string }).text)
        ? [{ status: 'frozen' }]
        : [
            {
              id: 'r1',
              status: 'ready',
              vocabVersion: 'a'.repeat(64),
              specHash: 'd'.repeat(64),
              payloadSha256: sha,
              payloadBytes: 3,
              objectKey: `p/${sha}`,
              createdAt: new Date(),
            },
          ]
    );
    spies.s3Objects.mockReturnValue({
      prefix: 'p',
      get: async () => ({ bytes: Buffer.from('abc'), sha256: sha }),
    });
    const { tagIndexSnapshotHolder } = await import(
      '~/server/services/resource-intent-tags/holder'
    );
    await tagIndexSnapshotHolder().resolve();
    expect(spies.decodeWorkerImported).toHaveBeenCalled();
    expect(spies.decodeInWorker).toHaveBeenCalledTimes(1);
    expect(spies.decodeInWorker).toHaveBeenCalledWith(expect.any(Uint8Array), {
      signal: expect.any(AbortSignal),
    });
  });

  it('its flag key is the one the doc names (default-off is Flipt state)', () => {
    expect(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_HOLDER).toBe(
      'resource-intent-tag-index-holder'
    );
  });
});
