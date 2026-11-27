import { PGlite } from '@electric-sql/pglite';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  unblock: vi.fn(),
  updateFlag: vi.fn(),
  trackImages: vi.fn(),
  db: null as unknown as PGlite,
}));

vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => h.db);
  return { kyselyRead: db, kyselyWrite: db };
});

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  handleUnblockImages: h.unblock,
  updateImagesFlag: h.updateFlag,
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    images = h.trackImages;
  },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));

import handler from '~/server/api-routes/mod/restore-images';
import flagHandler from '~/server/api-routes/mod/update-image-flag';
import { WITHHELD_LOOSENING_REFUSED } from '~/server/services/moderator-withheld.service';

const row = (id: number, blockedFor: string | null, needsReview: string | null = null) => ({
  id,
  userId: 1,
  nsfwLevel: 1,
  blockedFor,
  needsReview,
  tags: [],
});

const found = (rows: ReturnType<typeof row>[]) =>
  vi.mocked(dbMock.dbWrite.image.findMany).mockResolvedValue(rows as never);

// 1 shares its url with 3, a CSAM block, so it is withheld from a moderator without the grant.
const WITHHELD = 1;
const PLAIN = 2;

beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
    ${WITHHELD_TABLES_SQL}
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared', 'Blocked', 'moderated', 7),
      (${PLAIN}, 'plain', 'Blocked', 'moderated', 7),
      (3, 'shared', 'Blocked', 'CSAM', 8);
  `);
});

const restore = async (
  imageIds: number[],
  grant: Record<string, unknown> = { csamReview: true }
) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
    { method: 'POST', body: { imageIds, ...grant } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.json.mock.calls[0]?.[0];
};

beforeEach(() => {
  // The service answers with the images it restored; by default, all it was given.
  h.unblock.mockReset().mockImplementation(async ({ ids }: { ids: number[] }) => ({
    restored: ids.map((id) => ({ id })),
    kept: [],
  }));
  h.trackImages.mockReset();
  h.updateFlag.mockReset().mockImplementation(async ({ ids }: { ids: number[] }) => ids);
});

describe('/api/mod/restore-images', () => {
  it('skips a CSAM-blocked image and still restores the others in the batch', async () => {
    found([row(1, 'CSAM'), row(2, 'moderated')]);

    const body = await restore([1, 2]);

    expect(h.unblock.mock.calls.map(([arg]) => arg.ids)).toEqual([[2]]);
    expect(body).toEqual({ images: 1, restored: [2], skipped: [1] });
  });

  it('skips an image under the CSAM review flag, blocked or not, and restores the others', async () => {
    found([row(1, 'moderated', 'csam'), row(2, null, 'csam'), row(3, 'moderated', 'minor')]);

    const body = await restore([1, 2, 3]);

    expect(h.unblock.mock.calls.map(([arg]) => arg.ids)).toEqual([[3]]);
    expect(body).toEqual({ images: 1, restored: [3], skipped: [1, 2] });
  });

  it('restores nothing when every image is CSAM-blocked', async () => {
    found([row(1, 'CSAM')]);

    const body = await restore([1]);

    expect(h.unblock).not.toHaveBeenCalled();
    expect(body).toEqual({ images: 0, restored: [], skipped: [1] });
  });

  it('skips an image the replica has not yet seen CSAM-blocked', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([row(1, 'moderated')] as never);
    found([row(1, 'CSAM')]);

    const body = await restore([1]);

    expect(h.unblock).not.toHaveBeenCalled();
    expect(body).toEqual({ images: 0, restored: [], skipped: [1] });
  });

  it('counts only the images the service restored', async () => {
    found([row(2, 'moderated'), row(3, 'moderated')]);
    // 2 was kept blocked (its owner is deleted): not restored, so neither counted nor tracked.
    h.unblock.mockResolvedValueOnce({ restored: [{ id: 3 }], kept: [{ id: 2 }] });

    const body = await restore([2, 3]);

    expect(body).toEqual({ images: 1, restored: [3], skipped: [] });
    expect(h.trackImages.mock.calls[0][0].map((e: { imageId: number }) => e.imageId)).toEqual([3]);
  });

  describe('an image withheld from the moderator', () => {
    it.each([
      ['no grant sent', {}],
      ['the grant sent as false', { csamReview: false }],
      ['the grant sent as a string', { csamReview: 'true' }],
    ])('is skipped with %s, and the rest restored', async (_label, grant) => {
      found([row(WITHHELD, 'moderated'), row(PLAIN, 'moderated')]);

      const body = await restore([WITHHELD, PLAIN], grant);

      // `handleUnblockImages` is what approves the image's pending appeal; it never sees this one.
      expect(h.unblock.mock.calls.map(([arg]) => arg.ids)).toEqual([[PLAIN]]);
      expect(body).toEqual({ images: 1, restored: [PLAIN], skipped: [WITHHELD] });
    });

    it('is restored for a moderator holding the grant', async () => {
      found([row(WITHHELD, 'moderated')]);

      const body = await restore([WITHHELD], { csamReview: true });

      expect(h.unblock.mock.calls.map(([arg]) => arg.ids)).toEqual([[WITHHELD]]);
      expect(body).toEqual({ images: 1, restored: [WITHHELD], skipped: [] });
    });
  });

  it("skips an image the service's own write refused, and passes the grant down", async () => {
    found([row(PLAIN, 'moderated')]);
    h.unblock.mockResolvedValueOnce({ restored: [], kept: [] });

    const body = await restore([PLAIN], { csamReview: false });

    expect(h.unblock.mock.calls[0][0]).toMatchObject({ ids: [PLAIN], csamReview: false });
    expect(body).toEqual({ images: 0, restored: [], skipped: [PLAIN] });
  });

  it('restores an image nothing withholds without the grant', async () => {
    found([row(PLAIN, 'moderated')]);

    const body = await restore([PLAIN], { csamReview: false });

    expect(body).toEqual({ images: 1, restored: [PLAIN], skipped: [] });
  });
});

describe('/api/mod/update-image-flag', () => {
  const setFlag = async (query: Record<string, string>) => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
      headersSent: false,
    };
    await (flagHandler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      { method: 'GET', query: { flag: 'minor', ...query } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    lastBody = res.json.mock.calls[0]?.[0];
    return res.status.mock.calls[0]?.[0] as number;
  };
  let lastBody: unknown;

  it.each([
    ['no grant sent', {}],
    ['the grant sent as false', { csamReview: 'false' }],
    ['the grant sent as anything else', { csamReview: '1' }],
  ])(
    'refuses clearing a flag on a withheld image with %s, and writes nothing',
    async (_l, grant) => {
      expect(await setFlag({ ids: `${PLAIN},${WITHHELD}`, value: 'false', ...grant })).toBe(403);
      expect(h.updateFlag).not.toHaveBeenCalled();
      // The generic refusal: it names no reason the image is withheld.
      expect(JSON.stringify(lastBody)).toContain(WITHHELD_LOOSENING_REFUSED);
      expect(JSON.stringify(lastBody)).not.toMatch(/csam/i);
    }
  );

  it('clears it for a moderator holding the grant', async () => {
    expect(await setFlag({ ids: `${WITHHELD}`, value: 'false', csamReview: 'true' })).toBe(200);
    expect(h.updateFlag).toHaveBeenCalledWith({
      ids: [WITHHELD],
      flag: 'minor',
      value: false,
      withheldFor: { csamReview: true },
    });
  });

  it('clears it on an image nothing withholds, without the grant', async () => {
    expect(await setFlag({ ids: `${PLAIN}`, value: 'false', csamReview: 'false' })).toBe(200);
    expect(h.updateFlag).toHaveBeenCalledWith({
      ids: [PLAIN],
      flag: 'minor',
      value: false,
      withheldFor: { csamReview: false },
    });
  });

  it('sets a flag on a withheld image without the grant: setting one loosens nothing', async () => {
    expect(await setFlag({ ids: `${WITHHELD}`, value: 'true' })).toBe(200);
    expect(h.updateFlag).toHaveBeenCalledWith({
      ids: [WITHHELD],
      flag: 'minor',
      value: true,
      withheldFor: undefined,
    });
  });
});
