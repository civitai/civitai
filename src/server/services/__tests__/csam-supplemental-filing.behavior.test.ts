import { readFileSync } from 'fs';
import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Filing a supplemental report: which images it may attach, and how many it says it left
 * unreviewed. Runs against a Postgres stand-in holding the set-aside migration. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));

const { createSupplementalCsamReport, getCsamSupplementalPreview } = await import(
  '~/server/services/csam-supplemental.service'
);

const MOD = 10;
const OWNER = 20;
const OTHER = 30;
const PRIOR = 1;

const db = { pg: null as unknown as PGlite };

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

// Prisma's tagged template as a parameterised query: the view lookup.
const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "needsReview" TEXT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned'
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "reportedById" INTEGER NOT NULL DEFAULT ${MOD},
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reportSentAt" TIMESTAMP(3),
  "reportId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}', "images" JSONB NOT NULL DEFAULT '[]',
  "type" TEXT NOT NULL DEFAULT 'Image'
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const SET_ASIDE_MIGRATION = readFileSync(
  new URL(
    '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_csam_queue_set_aside/migration.sql',
    import.meta.url
  ),
  'utf8'
);

const exec = (text: string) => db.pg.exec(text);

const image = (
  id: number,
  { userId = OWNER, flag = 'csam' as string | null, ingestion = 'Blocked' } = {}
) =>
  db.pg.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion") VALUES ($1, $2, $3, $4)`,
    [id, userId, flag, ingestion]
  );
const view = (id: number, activity = 'reportMedia:open:original') =>
  db.pg.query(
    `INSERT INTO "ModActivity" ("userId", "entityType", "activity", "entityId", "createdAt")
     VALUES ($1, 'image', $2, $3, CURRENT_TIMESTAMP - interval '1 second')`,
    [MOD, activity, id]
  );
const setAside = (id: number, outcome: 'Dismissed' | 'AfterReport') =>
  db.pg.query(
    `INSERT INTO "CsamQueueSetAside" ("imageId", "userId", "outcome", "moderatorId") VALUES ($1, $2, $3, $4)`,
    [id, OWNER, outcome, MOD]
  );
const report = (fields: {
  userId?: number;
  sent?: boolean;
  reportId?: number | null;
  images?: number[];
  type?: string;
  details?: object;
}) =>
  db.pg.query(
    `INSERT INTO "CsamReport" ("userId", "reportSentAt", "reportId", "images", "type", "details")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      fields.userId ?? OWNER,
      fields.sent === false ? null : new Date('2026-10-01T00:00:00Z'),
      fields.reportId === undefined ? 900 : fields.reportId,
      JSON.stringify((fields.images ?? []).map((id) => ({ id }))),
      fields.type ?? 'Image',
      JSON.stringify(fields.details ?? {}),
    ]
  );

const file = (imageIds: number[], supplementalOf = PRIOR) =>
  createSupplementalCsamReport({
    reportedById: MOD,
    userId: OWNER,
    type: 'Image',
    imageIds,
    supplementalOf,
    details: { minorDepiction: 'non-real' },
  });

const filed = async () =>
  (
    await db.pg.query<{ images: unknown; details: { supplemental?: unknown } }>(
      `SELECT images, details FROM "CsamReport" WHERE details ? 'supplemental' ORDER BY id`
    )
  ).rows;

beforeAll(async () => {
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  await exec(SCHEMA);
  await exec(SET_ASIDE_MIGRATION);
  holder.kysely = new Kysely({ dialect: dialect(db.pg) });
});

beforeEach(async () => {
  await exec(
    `TRUNCATE "CsamQueueSetAside", "ModActivity", "CsamReport", "Image", "User" RESTART IDENTITY CASCADE`
  );
  await exec(`INSERT INTO "User" VALUES (${OWNER}), (${OTHER})`);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
  // The earlier report: sent, numbered, listing image 100.
  await image(100);
  await report({ images: [100] });
});

describe('a supplemental report', () => {
  it('files the confirmed images, refers to the earlier report and leaves the rest as unreviewed', async () => {
    await image(101);
    await view(101);
    await image(102);

    await file([101]);

    const [row] = await filed();
    expect(row.images).toEqual([{ id: 101 }]);
    expect(row.details).toEqual({
      minorDepiction: 'non-real',
      supplemental: {
        priorCsamReportId: PRIOR,
        priorReportNumbers: [900],
        unreviewedImageIds: [102],
      },
    });
  });

  it('counts an image set aside after an earlier report, and not one a moderator dismissed', async () => {
    await image(101);
    await view(101);
    await image(102); // open
    await image(103); // bulk dismissed: never opened
    await setAside(103, 'Dismissed');
    await image(104);
    await setAside(104, 'AfterReport');

    await file([101]);

    const [row] = await filed();
    expect(row.details.supplemental).toMatchObject({ unreviewedImageIds: [102, 104] });
  });

  it('counts no image an earlier report listed, none outside the queue and none of another user', async () => {
    await image(101);
    await view(101);
    await image(102);
    await report({ sent: false, reportId: null, images: [102] }); // filed, not yet sent
    await image(103, { ingestion: 'Error' });
    await image(104, { flag: null });
    await image(105, { userId: OTHER });

    await file([101]);

    const [row] = await filed();
    expect(row.details.supplemental).toMatchObject({ unreviewedImageIds: [] });
  });

  it('lists every sent report number on the user, of any type', async () => {
    await report({ reportId: 905, type: 'TrainingData' });
    await report({ reportId: null });
    await report({ sent: false, reportId: 901 }); // a CyberTip opened, then cancelled
    await report({ userId: OTHER, reportId: 950 });
    await image(101);
    await view(101);

    await file([101]);

    const [row] = await filed();
    expect(row.details.supplemental).toMatchObject({ priorReportNumbers: [900, 905] });
  });

  it('refuses an image no moderator was shown', async () => {
    await image(101);
    await image(102);
    await view(102);

    await expect(file([101, 102])).rejects.toThrow('Not reviewed on screen: #101');
    expect(await filed()).toEqual([]);
  });

  it('counts a view only of the kinds a send counts', async () => {
    await image(101);
    await view(101, 'heldMedia:view');

    await expect(file([101])).rejects.toThrow('Not reviewed on screen: #101');
  });

  it('refuses while an image a moderator was shown is neither filed nor dismissed', async () => {
    await image(101);
    await view(101);
    await image(102);
    await view(102, 'reportMedia:select:cdn-450');

    await expect(file([101])).rejects.toThrow('Reviewed but not decided: #102');
    expect(await filed()).toEqual([]);
  });

  it('files once the shown image is dismissed', async () => {
    await image(101);
    await view(101);
    await image(102);
    await view(102);
    await setAside(102, 'Dismissed');

    await file([101]);

    expect(await filed()).toHaveLength(1);
  });

  it('refuses another user’s image, and one a report already lists', async () => {
    await image(105, { userId: OTHER });
    await view(105);
    await view(100);

    await expect(file([105])).rejects.toThrow("Not this user's images: #105");
    await expect(file([100])).rejects.toThrow('Already in a report: #100');
  });

  it.each([
    ['unsent', { sent: false, reportId: null }],
    ['opened but never sent', { sent: false, reportId: 901 }],
    ['sent with no NCMEC number', { reportId: null }],
    ['on another user', { userId: OTHER }],
    ['not an image report', { type: 'TrainingData' }],
  ])('refuses to supplement a report %s', async (_, fields) => {
    await report(fields);
    await image(101);
    await view(101);

    await expect(file([101], 2)).rejects.toThrow('is not a sent image report on this user');
  });

  it('refuses while another supplemental report on the user waits to send, and never folds into it', async () => {
    await image(101);
    await view(101);
    await image(102);
    await file([101]);
    await view(102);

    await expect(file([102])).rejects.toThrow('is waiting to send');
    expect((await filed()).map((r) => r.images)).toEqual([[{ id: 101 }]]);
  });

  it('is not held back by a supplemental report already sent', async () => {
    await report({ reportId: 910, images: [99], details: { supplemental: {} } });
    await image(101);
    await view(101);

    await file([101]);

    expect(await filed()).toHaveLength(2);
  });

  it('is its own report beside an unsent ordinary one', async () => {
    await report({ sent: false, reportId: null, images: [] });
    await image(101);
    await view(101);

    await file([101]);

    const { rows } = await db.pg.query(`SELECT id, images FROM "CsamReport" ORDER BY id`);
    expect(rows.map((r: { images: unknown }) => r.images)).toEqual([
      [{ id: 100 }],
      [],
      [{ id: 101 }],
    ]);
  });

  it('previews the exact text NCMEC receives', async () => {
    await image(101);
    await view(101);
    await image(102);

    await expect(
      getCsamSupplementalPreview({
        userId: OWNER,
        imageIds: [101],
        supplementalOf: PRIOR,
        reportedById: MOD,
      })
    ).resolves.toEqual({
      priorReportNumbers: [900],
      unreviewed: 1,
      text: 'A Civitai reviewer confirmed the attached image(s). The account has 1 further image that was flagged for review and not individually reviewed. It is preserved and available in response to legal process.',
    });
  });
});
