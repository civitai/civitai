import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { APPEAL_MEDIA_SCHEMA as SCHEMA } from '$lib/server/__tests__/appeal-media-schema';

/**
 * What the card load sends for an image withheld from a moderator without the restricted-review
 * grant: the row, with nothing a tile or a link could load the image from. The tile asks the
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
// ClickHouse is the boundary: a removal reason for the restricted image, and the scanner's CSAM
// label on `scanner.hits`, or no answer at all while `scanner.down`.
const { scanner } = vi.hoisted(() => ({ scanner: { hits: [] as number[], down: false } }));
vi.mock('$lib/server/clickhouse', async () => {
  const { imageAuditContentHash } = await import('@civitai/shared/media-signals');
  return {
    getClickhouse: () => ({
      query: async ({
        query,
        query_params,
      }: {
        query: string;
        query_params: { hashes?: string[] };
      }) => {
        if (query.includes('tosReason'))
          return { json: async () => [{ imageId: 201, tosReason: 'removed' }] };
        if (scanner.down) throw new Error('scanner unavailable');
        const hit = new Set(scanner.hits.map(imageAuditContentHash));
        return {
          json: async () =>
            (query_params.hashes ?? [])
              .filter((h) => hit.has(h))
              .map((contentHash) => ({ contentHash, csamHit: 1 })),
        };
      },
    }),
  };
});
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { load, actions } = await import('../+page.server');
const { getModeratorMedia, withheldMedia } = await import('$lib/server/retracted-media');

const RESTRICTED = 201;
const CONTROL = 202;
const SIGNAL = 203;
const HELD = 204;
const SHARED_URL = 205;
const SIGNAL_SIBLING = 207;
const CLEAN_SIBLING = 209;
const SCANNER_HIT = 211;
const SCANNER_SIBLING = 212;
const KEY = 'restricted-key';

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  scanner.hits = [SCANNER_HIT, 213];
  scanner.down = false;
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other'), (9, 'third'), (10, 'fourth'), (11, 'fifth'), (12, 'sixth'), (14, 'seventh'), (15, 'eighth'), (16, 'ninth'), (17, 'tenth');
    INSERT INTO "Image" (id, url, type, ingestion, "needsReview", "blockedFor", width, height, "userId") VALUES
      (${RESTRICTED}, '${KEY}', 'video', 'Blocked', 'appeal', 'CSAM', 512, 768, 7),
      (${CONTROL}, 'control-key', 'image', 'Blocked', 'appeal', 'moderated', 640, 480, 8),
      (${SIGNAL}, 'signal-key', 'image', 'Blocked', 'appeal', 'CSAM,moderated', 300, 300, 9),
      (${HELD}, 'held-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 10),
      (${SHARED_URL}, 'shared-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 11),
      (206, 'shared-key', 'image', 'Pending', NULL, NULL, 300, 300, 12),
      (${SIGNAL_SIBLING}, 'signal-sibling-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 14),
      (208, 'signal-sibling-key', 'image', 'Blocked', NULL, 'CSAM', 300, 300, 12),
      (${CLEAN_SIBLING}, 'clean-sibling-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 15),
      (210, 'clean-sibling-key', 'image', 'Scanned', NULL, NULL, 300, 300, 12),
      (${SCANNER_HIT}, 'scanner-hit-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 16),
      (${SCANNER_SIBLING}, 'scan-sibling-key', 'image', 'Blocked', 'appeal', 'moderated', 300, 300, 17),
      (213, 'scan-sibling-key', 'image', 'Scanned', NULL, NULL, 300, 300, 12);
    INSERT INTO "CsamReport" ("userId", details, images) VALUES (13, '{}', jsonb_build_array(jsonb_build_object('id', ${HELD})));
    INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES
      (7, 'Image', ${RESTRICTED}), (8, 'Image', ${CONTROL}), (9, 'Image', ${SIGNAL}), (10, 'Image', ${HELD}), (11, 'Image', ${SHARED_URL}),
      (14, 'Image', ${SIGNAL_SIBLING}), (15, 'Image', ${CLEAN_SIBLING}), (16, 'Image', ${SCANNER_HIT}), (17, 'Image', ${SCANNER_SIBLING});
    INSERT INTO "Model3D" (id, name, status, "thumbnailImageId") VALUES (1, 'parent', 'Published', ${RESTRICTED});
    INSERT INTO "User" (id, username) VALUES (13, 'reporter');
    INSERT INTO "Report" (id, "userId", reason, status, details, "createdAt") VALUES
      (1, 13, 'TOSViolation', 'Actioned', '{"comment": "x"}', '2026-09-01');
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${RESTRICTED}, 1);
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
    expect(await card(WITHOUT_GRANT, RESTRICTED)).toMatchObject(withheldMedia());
  });

  it.each([
    ['url', ''],
    ['width', null],
    ['height', null],
    ['type', null],
    ['model3d', null],
    ['blockedFor', null],
    ['tosReason', null],
    ['reports', []],
  ])('serves no %s for it', async (field, empty) => {
    expect((await card(WITHOUT_GRANT, RESTRICTED))[field]).toEqual(empty);
  });

  // No other field carries the storage key either: the image id is the only handle left, and the
  // two routes that take one refuse it (below).
  it('serves neither its appeal text nor its overturned removal label', async () => {
    await db.exec(`INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status) VALUES
        (990000060, 7, 'Image', ${RESTRICTED}, 'Approved');
      INSERT INTO "AppealDecisionRecord" ("appealId", "removalLabel") VALUES (990000060, 'overturned-label');
      UPDATE "Appeal" SET "appealMessage" = 'appeal text' WHERE "entityId" = ${RESTRICTED}`);
    expect(await card(WITHOUT_GRANT, RESTRICTED)).toMatchObject({
      appeal: { message: '' },
      approvedAppeal: { removalLabel: null },
    });
    expect(await card(WITH_GRANT, RESTRICTED)).toMatchObject({
      appeal: { message: 'appeal text' },
      approvedAppeal: { removalLabel: 'overturned-label' },
    });
  });

  it('serves no flag that could say why it is withheld', async () => {
    await db.exec(
      `UPDATE "Image" SET minor = true, poi = true, "modelRestricted" = true WHERE id = ${RESTRICTED}`
    );
    expect(await card(WITHOUT_GRANT, RESTRICTED)).toMatchObject({
      minor: false,
      poi: false,
      modelRestricted: false,
      removedAt: null,
      moderatorUsername: null,
    });
  });

  it('serves the storage key in no field at all', async () => {
    expect(JSON.stringify(await card(WITHOUT_GRANT, RESTRICTED))).not.toContain(KEY);
  });

  it('withholds a row a CSAM report lists, whatever its block reason', async () => {
    expect(await card(WITHOUT_GRANT, HELD)).toMatchObject({ restricted: true, url: '' });
  });

  // The moderator-view rule reads Postgres only, and none of these is a CSAM mark of a row: a url
  // sibling still scanning, or the scanner's label on the row or a sibling.
  it('serves a row only the scanner or an unscanned sibling would have kept (civitai/civitai#10377)', async () => {
    for (const id of [SHARED_URL, SCANNER_HIT, SCANNER_SIBLING])
      expect({ id, card: await card(WITHOUT_GRANT, id) }).toMatchObject({
        id,
        card: { restricted: false },
      });
  });

  it('withholds a row with CSAM among its block reasons', async () => {
    expect(await card(WITHOUT_GRANT, SIGNAL)).toMatchObject({ restricted: true, url: '' });
  });

  it('serves a row while the scanner cannot answer', async () => {
    scanner.down = true;
    expect(await card(WITHOUT_GRANT, CONTROL)).toMatchObject({ restricted: false });
  });

  it('withholds a row whose url sibling carries a signal, and refuses its ruling', async () => {
    expect(await card(WITHOUT_GRANT, SIGNAL_SIBLING)).toMatchObject({ restricted: true, url: '' });
    const data = new FormData();
    data.append('imageId', String(SIGNAL_SIBLING));
    data.append('status', 'Approved');
    data.append('resolvedReason', 'misclassified');
    const result = (await actions.resolveAppeal({
      request: { formData: async () => data },
      locals: { user: WITHOUT_GRANT },
    } as unknown as Parameters<(typeof actions)['resolveAppeal']>[0])) as { status: number };
    expect(result.status).toBe(403);
  });

  it('serves a row whose url sibling carries no signal', async () => {
    expect(await card(WITHOUT_GRANT, CLEAN_SIBLING)).toMatchObject({
      restricted: false,
      url: 'clean-sibling-key',
    });
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
      blockedFor: 'CSAM',
      tosReason: 'removed',
      reports: [expect.objectContaining({ id: 1 })],
    });
  });
});
