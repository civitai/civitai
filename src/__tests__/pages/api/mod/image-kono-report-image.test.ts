import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { constants } from '~/server/common/constants';

/**
 * The Knights report route, through the real webhook-token check and the real `createReport`, on
 * PGlite tables shaped like the Report and ImageReport rows it writes.
 */

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instrumentApiResponse: () => undefined,
}));

const { default: handler } = await import('~/server/api-routes/mod/image/kono-report-image');
const { ModEndpoint } = await import('~/server/utils/endpoint-helpers');
const { createReport } = await import('~/server/services/report.service');
const { ReportEntity } = await import('~/shared/utils/report-helpers');
const { ReportReason } = await import('~/shared/utils/prisma/enums');

const SCHEMA = `
  CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Ownership', 'AdminAttention', 'Claim', 'CSAM', 'Automated', 'Spam', 'StickerPlacement');
  CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
  CREATE TABLE "Image" (id int PRIMARY KEY);
  CREATE TABLE "Report" (
    id serial PRIMARY KEY, "userId" int NOT NULL, reason "ReportReason" NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), details jsonb, "internalNotes" text,
    "previouslyReviewedCount" int NOT NULL DEFAULT 0, "alsoReportedBy" int[] NOT NULL DEFAULT '{}',
    status "ReportStatus" NOT NULL, "statusSetAt" timestamp(3), "statusSetBy" int
  );
  CREATE TABLE "ImageReport" ("imageId" int NOT NULL, "reportId" int NOT NULL UNIQUE, PRIMARY KEY ("reportId", "imageId"));
`;

const TOKEN = 'k'.repeat(40);
const IMAGE = 12;
const OTHER_IMAGE = 13;
const PLAYER = 5;
const KNIGHTS_VIOLATION = 'Knights players reported this image';
const SYSTEM = constants.system.user.id;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
const q = async <T>(sql: string) => (await harness.pg.query<T>(sql)).rows;

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  const prisma = harness.prisma;
  dbMock.dbWrite.$transaction.mockImplementation(((fn: Parameters<typeof prisma.$transaction>[0]) =>
    prisma.$transaction(fn)) as never);
  for (const method of ['findFirst', 'create', 'update'] as const)
    dbMock.dbWrite.report[method].mockImplementation(((...a: never[]) =>
      (prisma.report[method] as (...b: never[]) => unknown)(...a)) as never);
  // A TOS report's hide of the image runs on a second connection while the report's transaction holds
  // the harness's only one, so it is answered here instead.
  dbMock.dbWrite.imageEngagement.create.mockResolvedValue({} as never);
  for (const client of [dbMock.dbRead, dbMock.dbWrite])
    client.image.findUnique.mockImplementation(((...a: never[]) =>
      (prisma.image.findUnique as (...b: never[]) => unknown)(...a)) as never);
});
afterAll(async () => {
  await harness?.stop();
});
// Redis SET NX and the lock's compare-and-delete, so the route's lock holds as it does in Redis.
const redisKeys = new Map<string, string>();
beforeEach(async () => {
  resetEnv();
  setEnv({ WEBHOOK_TOKEN: TOKEN });
  dbMock.dbWrite.imageEngagement.create.mockClear();
  redisKeys.clear();
  redisMock.redis.set.mockImplementation((async (
    key: string,
    value: string,
    options?: { NX?: boolean }
  ) => {
    if (options?.NX && redisKeys.has(key)) return null;
    redisKeys.set(key, value);
    return 'OK';
  }) as never);
  redisMock.redis.eval.mockImplementation((async (
    _script: string,
    { keys: [key], arguments: [value] }: { keys: string[]; arguments: string[] }
  ) => {
    if (redisKeys.get(key) !== value) return 0;
    redisKeys.delete(key);
    return 1;
  }) as never);
  await harness.pg.exec(`
    TRUNCATE "Report", "ImageReport", "Image" RESTART IDENTITY;
    INSERT INTO "Image" (id) VALUES (${IMAGE}), (${OTHER_IMAGE});
  `);
});

const call = async (
  body: unknown,
  headers: Record<string, string> = { 'x-webhook-token': TOKEN },
  method = 'POST',
  context?: Record<string, unknown>
) => {
  let status = 200;
  let json: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      json = value;
      return res;
    },
  } as unknown as NextApiResponse;
  const req = {
    method,
    url: '/api/mod/image/kono-report-image',
    query: {},
    headers,
    body,
    context,
  };
  await (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    req as unknown as NextApiRequest,
    res
  );
  return { status, json };
};

const reportIdOf = (json: unknown) => (json as { reportId: number }).reportId;

const reports = () =>
  q<{ id: number; userId: number; reason: string; status: string; details: unknown }>(
    `SELECT r.id, r."userId", r.reason, r.status, r.details FROM "Report" r JOIN "ImageReport" ir ON ir."reportId" = r.id ORDER BY r.id`
  );

describe('/api/mod/image/kono-report-image', () => {
  it('refuses a signed-in user session that carries no webhook token, and files nothing', async () => {
    const { status } = await call(
      { imageId: IMAGE },
      { cookie: '__Secure-civitai-token=session; civ-token=session' }
    );

    expect(status).toBe(401);
    expect(await reports()).toEqual([]);
  });

  it('refuses a moderator session that carries no webhook token, and files nothing', async () => {
    const moderator = () => ({ session: { user: { id: 1, isModerator: true } } });
    const headers = { cookie: 'civ-token=moderator-session' };
    const modRoute = ModEndpoint(async (_req, res) => res.status(200).json({}), ['POST']);
    const modStatus = await (async () => {
      let code = 200;
      const res = {
        status: (c: number) => ((code = c), res),
        json: () => res,
        setHeader: () => res,
      } as unknown as NextApiResponse;
      await (modRoute as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<void>)(
        {
          method: 'POST',
          url: '/x',
          query: {},
          headers,
          body: {},
          context: moderator(),
        } as unknown as NextApiRequest,
        res
      );
      return code;
    })();
    expect(modStatus).toBe(200);

    const { status } = await call({ imageId: IMAGE }, headers, 'POST', moderator());

    expect(status).toBe(401);
    expect(await reports()).toEqual([]);
  });

  it('files one TOS report on the image as the system user, with the fixed details', async () => {
    const { status, json } = await call({ imageId: IMAGE });

    const filed = await reports();
    expect(filed).toEqual([
      {
        id: expect.any(Number),
        userId: SYSTEM,
        reason: 'TOSViolation',
        status: 'Pending',
        details: expect.objectContaining({ violation: KNIGHTS_VIOLATION }),
      },
    ]);
    expect(status).toBe(200);
    expect(json).toEqual({ reportId: filed[0].id, created: true });
    expect(dbMock.dbWrite.imageEngagement.create).toHaveBeenCalledTimes(1);
  });

  it('returns the open report it already filed on a second call, and writes nothing', async () => {
    const first = await call({ imageId: IMAGE });
    const before = await q(`SELECT * FROM "Report"`);
    const second = await call({ imageId: IMAGE });

    expect(second.status).toBe(200);
    expect(second.json).toEqual({
      reportId: (first.json as { reportId: number }).reportId,
      created: false,
    });
    expect(await q(`SELECT * FROM "Report"`)).toEqual(before);
    expect(dbMock.dbWrite.imageEngagement.create).toHaveBeenCalledTimes(1);
  });

  it.each(['Processing', 'Actioned', 'Unactioned'])(
    'returns the report it filed once a moderator has it %s, and files no second one',
    async (status) => {
      const first = await call({ imageId: IMAGE });
      await harness.pg.exec(`UPDATE "Report" SET status = '${status}'`);
      const second = await call({ imageId: IMAGE });

      expect(second.json).toEqual({ reportId: reportIdOf(first.json), created: false });
      expect(await reports()).toHaveLength(1);
    }
  );

  it('files for another image although this one has its report', async () => {
    const first = await call({ imageId: IMAGE });
    const other = await call({ imageId: OTHER_IMAGE });

    expect(other.json).toEqual({ reportId: expect.any(Number), created: true });
    expect(reportIdOf(other.json)).not.toBe(reportIdOf(first.json));
  });

  it("files although the image has a closed system TOS report that is not this route's", async () => {
    await harness.pg.exec(`
      INSERT INTO "Report" ("userId", reason, status, details)
        VALUES (${SYSTEM}, 'TOSViolation', 'Unactioned', '{"violation": "Held by another check"}');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${IMAGE}, 1);
    `);
    const { json } = await call({ imageId: IMAGE });

    expect(json).toEqual({ reportId: 2, created: true });
  });

  it('answers 503 and files nothing while another filing for the image holds the lock', async () => {
    redisMock.redis.set.mockResolvedValue(null as never);
    const { status } = await call({ imageId: IMAGE });

    expect(status).toBe(503);
    expect(await q(`SELECT id FROM "Report"`)).toEqual([]);
  });

  it('files one report when two calls for the image arrive together', async () => {
    const [a, b] = await Promise.all([call({ imageId: IMAGE }), call({ imageId: IMAGE })]);

    expect(await reports()).toHaveLength(1);
    expect([a.json, b.json]).toEqual(
      expect.arrayContaining([
        { reportId: 1, created: true },
        { reportId: 1, created: false },
      ])
    );
  });

  it("sends a player's later TOS report to the queue after a moderator dismissed this route's", async () => {
    const knights = reportIdOf((await call({ imageId: IMAGE })).json);
    await harness.pg.exec(`UPDATE "Report" SET status = 'Unactioned'`);

    await createReport({
      type: ReportEntity.Image,
      id: IMAGE,
      userId: PLAYER,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Graphic violence' },
    });

    const rows = await q<{ id: number; userId: number; status: string; alsoReportedBy: number[] }>(
      `SELECT id, "userId", status, "alsoReportedBy" FROM "Report" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: knights, userId: SYSTEM, status: 'Unactioned', alsoReportedBy: [] },
      { id: expect.any(Number), userId: PLAYER, status: 'Pending', alsoReportedBy: [] },
    ]);
  });

  it("files nothing new for a player who already co-reported this route's dismissed report", async () => {
    const knights = reportIdOf((await call({ imageId: IMAGE })).json);
    await harness.pg.exec(
      `UPDATE "Report" SET status = 'Unactioned', "alsoReportedBy" = ARRAY[${PLAYER}]::int[]`
    );

    await createReport({
      type: ReportEntity.Image,
      id: IMAGE,
      userId: PLAYER,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Graphic violence' },
    });

    const rows = await q<{ id: number; status: string }>(
      `SELECT id, status FROM "Report" ORDER BY id`
    );
    expect(rows).toEqual([{ id: knights, status: 'Unactioned' }]);
  });

  it("joins a player's TOS report still waiting for a moderator, and says it created none", async () => {
    await harness.pg.exec(`
      INSERT INTO "Report" ("userId", reason, status, details) VALUES (5, 'TOSViolation', 'Pending', '{}');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${IMAGE}, 1);
    `);
    const { json } = await call({ imageId: IMAGE });

    expect(json).toEqual({ reportId: 1, created: false });
    expect(await reports()).toHaveLength(1);
  });

  it.each([
    ['a reason', { imageId: IMAGE, reason: 'NSFW' }],
    ['details', { imageId: IMAGE, details: 'free text' }],
    ['a reporter', { imageId: IMAGE, userId: 5 }],
    ['no image id', {}],
    ['a non-integer image id', { imageId: 1.5 }],
    ['a negative image id', { imageId: -3 }],
  ])('answers 400 for a body with %s, and files nothing', async (_label, body) => {
    const { status } = await call(body);

    expect(status).toBe(400);
    expect(await reports()).toEqual([]);
  });

  it('answers 404 for an image that does not exist, and files nothing', async () => {
    const { status } = await call({ imageId: 999 });

    expect(status).toBe(404);
    expect(await q(`SELECT id FROM "Report"`)).toEqual([]);
  });

  it('only answers POST', async () => {
    const { status } = await call({ imageId: IMAGE }, undefined, 'GET');

    expect(status).toBe(405);
    expect(await reports()).toEqual([]);
  });
});
