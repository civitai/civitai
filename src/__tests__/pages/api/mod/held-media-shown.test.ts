import { PGlite } from '@electric-sql/pglite';
import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `/api/mod/held-media/shown`: one row per image a moderator opened or selected on the CSAM report
 * page. The handler is called as a moderator (ModEndpoint is pinned in the mod-only test); the row
 * goes through the real `trackModActivity` into a Postgres stand-in, so who and when are what the
 * database recorded.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const getHeldMedia = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ csamReports: true }));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 42, isModerator: true }),
}));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: () => flags }));
vi.mock('~/server/services/held-media.service', () => ({ getHeldMedia }));

import handler from '~/pages/api/mod/held-media/shown';

const pg = new PGlite({
  parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
});
// Prisma types an array parameter; the stand-in is told `trackModActivity`'s ids are ints.
const executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (
    await pg.query(
      strings
        .map((part, i) => (i ? `$${i}` : '') + part)
        .join('')
        .replace(/UNNEST\((\$\d+)\)/, 'UNNEST($1::int[])'),
      values
    )
  ).affectedRows ?? 0;

const rows = async () =>
  (
    await pg.query<{
      userId: number;
      activity: string;
      entityType: string;
      entityId: number;
      createdAt: Date;
    }>(`SELECT "userId", activity, "entityType", "entityId", "createdAt" FROM "ModActivity"`)
  ).rows;

async function post(body: unknown) {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    query: {},
    headers: {},
    body,
  }) as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: () => res,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
    end: () => res,
  });
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
}

const valid = { imageId: 501, userId: 20, action: 'select', rendition: 'cdn-450' };

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM "ModActivity"`);
  flags.csamReports = true;
  getHeldMedia.mockReset().mockResolvedValue(null);
  dbMock.dbWrite.$executeRaw.mockReset().mockImplementation(executeRaw as never);
  // Image 501 is user 20's, on whose report page it is; 502 is user 21's.
  const owners: Record<number, number> = { 501: 20, 502: 21 };
  dbMock.dbWrite.image.findFirst
    .mockReset()
    .mockImplementation((async ({ where }: { where: { id: number; userId?: number } }) =>
      where.id in owners && (where.userId === undefined || owners[where.id] === where.userId)
        ? { id: where.id }
        : null) as never);
});

describe('POST /api/mod/held-media/shown', () => {
  it('records the act and rendition against the session moderator, at database time', async () => {
    const before = (await pg.query<{ now: Date }>(`SELECT LOCALTIMESTAMP AS now`)).rows[0].now;

    expect(await post(valid)).toBe(204);

    const after = (await pg.query<{ now: Date }>(`SELECT LOCALTIMESTAMP AS now`)).rows[0].now;
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      userId: 42,
      activity: 'reportMedia:select:cdn-450',
      entityType: 'image',
      entityId: 501,
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('records a held image as the original', async () => {
    getHeldMedia.mockResolvedValue({ url: 'key', type: 'image', mimeType: 'image/png' });

    expect(await post({ ...valid, action: 'open', rendition: 'original' })).toBe(204);

    expect((await rows()).map((row) => row.activity)).toEqual(['reportMedia:open:original']);
    expect(getHeldMedia).toHaveBeenCalledWith(501, dbMock.dbWrite);
  });

  it.each([
    ['moderatorId', { moderatorId: 7 }],
    ['actor', { actor: 7 }],
    ['createdAt', { createdAt: '2020-01-01T00:00:00Z' }],
    ['time', { time: 0 }],
  ])('refuses a body that names %s, and writes nothing', async (_, extra) => {
    expect(await post({ ...valid, ...extra })).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['an unknown act', { action: 'hover' }],
    ['an unknown rendition', { rendition: 'cdn-1080' }],
    ['a non-integer image', { imageId: 'x' }],
    ['an image id past int4', { imageId: 2 ** 31 }],
    ['a subject id past int4', { userId: 2 ** 31 }],
  ])('refuses %s, and writes nothing', async (_, change) => {
    expect(await post({ ...valid, ...change })).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('refuses an image that is not the subject’s, and writes nothing', async () => {
    expect(await post({ ...valid, imageId: 502 })).toBe(404);
    expect(await post({ ...valid, userId: 21 })).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('refuses a rendition the image cannot have been shown in, and writes nothing', async () => {
    expect(await post({ ...valid, rendition: 'original' })).toBe(409);
    getHeldMedia.mockResolvedValue({ url: 'key', type: 'image', mimeType: 'image/png' });
    expect(await post({ ...valid, rendition: 'cdn-450' })).toBe(409);
    expect(await rows()).toEqual([]);
  });

  it('refuses a moderator without the CSAM reports flag, and writes nothing', async () => {
    flags.csamReports = false;
    expect(await post(valid)).toBe(403);
    expect(await rows()).toEqual([]);
  });
});
