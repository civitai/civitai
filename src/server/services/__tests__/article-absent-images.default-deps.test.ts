import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * What `findAbsentImages` asks in production, with nothing injected: the other tests of it pass
 * their own probes, so none of them sees the key the store is asked about or the deny lookup run.
 */

const { headObject } = vi.hoisted(() => ({
  headObject: vi.fn(async () => ({ status: 'absent' as const })),
}));

// The upload store is the process boundary.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadProbeBackend: async () => ({
    s3: {} as never,
    bucket: 'uploads',
    backend: 'backblaze' as const,
  }),
  headObject,
}));

import { findAbsentImages } from '~/server/services/article-absent-images';
import { cdnStateUrls } from '~/server/services/cdn-access.service';

const MIXED = 'B7D4E0A2-31C5-4F68-9A03-5C8EF1276B4D';

describe('the store probe', () => {
  beforeEach(() => headObject.mockClear());

  // Kills: dropping the lowercasing. Objects are stored under lowercase keys, so a mixed-case key
  // asked as is reads absent with its file stored.
  it('asks the upload store about the lowercased key', async () => {
    await findAbsentImages([{ id: 1, url: MIXED }], { deniedUrls: async () => new Set() });

    expect(headObject).toHaveBeenCalledWith(
      'uploads',
      MIXED.toLowerCase(),
      expect.anything(),
      expect.anything()
    );
  });
});

describe('cdnStateUrls, the deny lookup', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "ImageCdnAccess" (url text PRIMARY KEY, state text NOT NULL, "lastAssertedAt" timestamp(3) NOT NULL DEFAULT now());
      INSERT INTO "ImageCdnAccess" (url, state) VALUES ('denied-key', 'Denied'), ('retracted-key', 'Retracted');
    `);
  }, 60_000);
  beforeEach(() => {
    dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
  });
  afterAll(() => pg.close());

  // Kills: a lookup that returns nothing, which would let a denied url's 404 read as a missing file.
  it('returns the denied and the retracted urls, and not one the image server serves', async () => {
    expect(await cdnStateUrls(['denied-key', 'retracted-key', 'served-key'])).toEqual(
      new Set(['denied-key', 'retracted-key'])
    );
  });
});
