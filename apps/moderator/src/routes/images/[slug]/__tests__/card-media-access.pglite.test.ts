import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { INQUISITOR_IMAGE_SCHEMA } from '$lib/server/knights/__tests__/inquisitor-schema';

/**
 * What the card load sends for an image kept to moderators with the restricted
 * review grant: the row, with nothing a tile or a link could load the image from. The tile asks the
 * CDN for whatever url the load gives it before the page hydrates, so the load is where it is
 * stripped, and these tests read the load's own return value.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// ClickHouse is the boundary: no removal reasons and no scanner rows.
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { load, actions } = await import('../+page.server');
const { getModeratorMedia } = await import('$lib/server/retracted-media');

const SCHEMA = `${INQUISITOR_IMAGE_SCHEMA}
ALTER TABLE "Image" ADD COLUMN width INTEGER, ADD COLUMN height INTEGER,
  ADD COLUMN poi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "modelRestricted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN username TEXT;
CREATE TABLE "Appeal" (
  id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "resolvedBy" INTEGER, "resolvedAt" TIMESTAMP(3),
  "resolvedReason" TEXT, "resolvedMessage" TEXT
);
CREATE TABLE "AppealDecisionRecord" ("appealId" INTEGER, "removalLabel" TEXT);
CREATE TABLE "ModActivity" (
  "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, activity TEXT, "createdAt" TIMESTAMP(3)
);
CREATE TABLE "Report" (
  id INTEGER PRIMARY KEY, "userId" INTEGER, reason TEXT, status TEXT, details JSONB,
  "createdAt" TIMESTAMP(3)
);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "Model3D" (id INTEGER PRIMARY KEY, name TEXT, status TEXT, "thumbnailImageId" INTEGER);
`;

const RESTRICTED = 201;
const CONTROL = 202;
const SIGNAL = 203;
const HELD = 204;
const KEY = 'restricted-key';

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other'), (9, 'third'), (10, 'fourth');
    INSERT INTO "Image" (id, url, type, ingestion, "needsReview", "blockedFor", width, height, "userId") VALUES
      (${RESTRICTED}, '${KEY}', 'video', 'Blocked', 'appeal', 'CSAM', 512, 768, 7),
      (${CONTROL}, 'control-key', 'image', 'Blocked', 'appeal', 'moderated', 640, 480, 8),
      (${SIGNAL}, 'signal-key', 'image', 'Blocked', 'appeal', 'CSAM,moderated', 300, 300, 9),
      (${HELD}, 'held-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 10);
    INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (${HELD});
    INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES
      (7, 'Image', ${RESTRICTED}), (8, 'Image', ${CONTROL}), (9, 'Image', ${SIGNAL}), (10, 'Image', ${HELD});
    INSERT INTO "Model3D" (id, name, status, "thumbnailImageId") VALUES (1, 'parent', 'Published', ${RESTRICTED});
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

type Card = Record<string, unknown> & { id: number };

const appealsFor = async (user: { id: number; roles: string[] }) => {
  const data = (await load({
    params: { slug: 'appeals' },
    url: new URL('http://moderator.test/images/appeals'),
    locals: { user },
  } as unknown as Parameters<typeof load>[0])) as { kind: string; items: Card[] };
  expect(data.kind).toBe('appeal');
  return data.items;
};

const card = async (user: { id: number; roles: string[] }, id: number) => {
  const found = (await appealsFor(user)).find((item) => item.id === id);
  if (!found) throw new Error(`image ${id} is not in the queue`);
  return found;
};

describe('card load, without the grant', () => {
  it('keeps the restricted row, marked restricted', async () => {
    expect(await card(WITHOUT_GRANT, RESTRICTED)).toMatchObject({ restricted: true });
  });

  it.each([
    ['url', ''],
    ['width', null],
    ['height', null],
    ['type', null],
    ['model3d', null],
  ])('serves no %s for it', async (field, empty) => {
    expect((await card(WITHOUT_GRANT, RESTRICTED))[field]).toEqual(empty);
  });

  // No other field carries the storage key either: the image id is the only handle left, and the
  // two routes that take one refuse it (below).
  it('serves the storage key in no field at all', async () => {
    expect(JSON.stringify(await card(WITHOUT_GRANT, RESTRICTED))).not.toContain(KEY);
  });

  it('withholds a row the Postgres rule restricts, whatever its block reason', async () => {
    expect(await card(WITHOUT_GRANT, HELD)).toMatchObject({ restricted: true, url: '' });
  });

  // The storage route's block-reason check, which the Postgres rule alone does not make.
  it('withholds a row whose block reason carries a signal', async () => {
    expect(await card(WITHOUT_GRANT, SIGNAL)).toMatchObject({ restricted: true, url: '' });
  });

  it('serves an unrestricted row as before', async () => {
    expect(await card(WITHOUT_GRANT, CONTROL)).toMatchObject({
      restricted: false,
      url: 'control-key',
      width: 640,
      height: 480,
      type: 'image',
    });
  });

  it('is refused the image by id on the storage route the tile falls back to', async () => {
    expect(await getModeratorMedia(RESTRICTED, { csamReview: false })).toBeNull();
    // The route serves it to a holder, so the refusal above is the grant's.
    expect(await getModeratorMedia(RESTRICTED, { csamReview: true })).toMatchObject({ url: KEY });
  });

  it('cannot rule on its appeal by posting the form', async () => {
    const data = new FormData();
    data.append('imageId', String(RESTRICTED));
    data.append('status', 'Approved');
    data.append('resolvedReason', 'misclassified');
    const result = (await actions.resolveAppeal({
      request: { formData: async () => data },
      locals: { user: WITHOUT_GRANT },
    } as unknown as Parameters<(typeof actions)['resolveAppeal']>[0])) as { status: number };

    expect(result.status).toBe(403);
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM "Appeal" WHERE "entityId" = $1`,
      [RESTRICTED]
    );
    expect(rows[0].status).toBe('Pending');
  });

  it('cannot rule on it in a batch, and the batch resolves nothing', async () => {
    const data = new FormData();
    data.append('imageIds', `${CONTROL},${RESTRICTED}`);
    data.append('status', 'Rejected');
    data.append('resolvedReason', 'violation-confirmed');
    const result = (await actions.bulkResolveAppeal({
      request: { formData: async () => data },
      locals: { user: WITHOUT_GRANT },
    } as unknown as Parameters<(typeof actions)['bulkResolveAppeal']>[0])) as { status: number };

    expect(result.status).toBe(403);
    const { rows } = await db.query<{ status: string }>(`SELECT DISTINCT status FROM "Appeal"`);
    expect(rows).toEqual([{ status: 'Pending' }]);
  });
});

describe('card load, with the grant', () => {
  it('serves the restricted row with its media', async () => {
    expect(await card(WITH_GRANT, RESTRICTED)).toMatchObject({
      restricted: false,
      url: KEY,
      width: 512,
      height: 768,
      type: 'video',
      model3d: { id: 1 },
    });
  });
});
