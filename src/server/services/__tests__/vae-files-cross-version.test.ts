import { describe, expect, it, vi, beforeEach } from 'vitest';
// 🔴 STATIC import, deliberately — see the note in get-models-raw.transient-503.test.ts:
// `model.service` is a ~4900-line module whose cold transform dominates this
// file's runtime. Hoisted to module scope that cost lands in Vitest's COLLECTION
// phase, which no `testTimeout` bounds. `vi.mock` calls below are hoisted above
// it by Vitest's transform, so the stubs still apply.
import { getVaeFiles } from '~/server/services/model.service';
import type * as RedisClient from '~/server/redis/client';

/**
 * `getVaeFiles` is the PRODUCER of the cross-version files that both public v1
 * shapers splice into a host version's file list. Everything downstream — the
 * `fileId` pin decision in `createSerializedFileDownloadUrl`, the download
 * route's `findFirst({ id, modelVersionId })` — rests on two properties of its
 * output that no other test pinned:
 *
 *   1. each returned file carries the LINKED version's id in `modelVersionId`,
 *      NOT the host version's (the host id is never even passed in);
 *   2. `type` is rewritten to 'VAE', so the file passes the shapers' Public
 *      filter and is serialized exactly like a local file — i.e. it is
 *      indistinguishable from one EXCEPT by `modelVersionId`.
 *
 * Only the Prisma call is stubbed; the selection + relabel are the real code.
 */

const { modelFileFindMany } = vi.hoisted(() => ({ modelFileFindMany: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelFile: { findMany: modelFileFindMany } },
  dbWrite: {},
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
// Breaks the `event-engine-common` submodule chain that otherwise blocks
// importing model.service in the unit env; nothing here is reached by getVaeFiles.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisClient>();
  return {
    ...actual,
    redis: { packed: { get: async () => null, set: async () => undefined } },
    sysRedis: {},
  };
});

const HOST_VERSION_ID = 4242;
const LINKED_VAE_VERSION_ID = 9999;

describe('getVaeFiles — returns files owned by the LINKED version, relabelled VAE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelFileFindMany.mockResolvedValue([
      {
        id: 91,
        modelVersionId: LINKED_VAE_VERSION_ID,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 5555,
        metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
        hashes: [{ type: 'SHA256', hash: 'eeee5555' }],
      },
    ]);
  });

  it('selects on the LINKED version ids and asks for modelVersionId explicitly', async () => {
    await getVaeFiles({ vaeIds: [LINKED_VAE_VERSION_ID] });
    expect(modelFileFindMany).toHaveBeenCalledTimes(1);
    const args = modelFileFindMany.mock.calls[0][0];
    expect(args.where.modelVersionId).toEqual({ in: [LINKED_VAE_VERSION_ID] });
    expect(args.where.type).toBe('Model');
    // Without this the owning version is unknowable downstream and the shaper
    // has to fall back to the host version — the bug.
    expect(args.select.modelVersionId).toBe(true);
  });

  it('the returned file belongs to the LINKED version, not the host', async () => {
    const [file] = await getVaeFiles({ vaeIds: [LINKED_VAE_VERSION_ID] });
    expect(file.modelVersionId).toBe(LINKED_VAE_VERSION_ID);
    expect(file.modelVersionId).not.toBe(HOST_VERSION_ID);
    // It keeps its OWN id — this is the id that gets pinned into a URL.
    expect(file.id).toBe(91);
  });

  it('rewrites type Model → VAE (which is why it passes the Public file filter)', async () => {
    const [file] = await getVaeFiles({ vaeIds: [LINKED_VAE_VERSION_ID] });
    expect(file.type).toBe('VAE');
    expect(file.visibility).toBe('Public');
  });
});
