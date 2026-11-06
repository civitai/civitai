import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { GENERATOR_EVIDENCE_VERSION } from '~/server/services/generator-evidence/evidence-meta';
import {
  evidenceViewActivity,
  getViewedEvidence,
} from '~/server/services/generator-evidence/evidence-views';

/**
 * A view on an earlier report carries over to a supplemental report only where the earlier report
 * preserved the same bytes. The earlier report's details are read by real SQL. All ids and hashes
 * below are invented.
 */

const db = { pg: null as unknown as PGlite };
const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

const USER = 5;
const CURRENT = 10;
const EARLIER = 3;
const OLD_VERSION = 4;
const MALFORMED = 6;
const NO_IMAGES = 7;
const MOD = 900;

const blob = (blobId: string, sha256: string, status = 'preserved') => ({ blobId, sha256, status });

let views: { activity: string; userId: number; entityId: number }[] = [];
const view = (entityId: number, blobId: string, userId = MOD) =>
  views.push({ activity: evidenceViewActivity(blobId), userId, entityId });

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`CREATE TABLE "CsamReport" ("id" INTEGER PRIMARY KEY, "details" JSONB);`);
  const insert = (id: number, details: unknown) =>
    db.pg.query(`INSERT INTO "CsamReport" ("id", "details") VALUES ($1, $2)`, [id, details]);
  await insert(EARLIER, {
    generatorEvidence: { version: GENERATOR_EVIDENCE_VERSION },
    generatedImages: [
      { blobs: [blob('same', 'sha-same'), blob('changed', 'sha-before')] },
      { blobs: [blob('failed', 'sha-failed', 'failed'), blob('unviewed', 'sha-unviewed')] },
    ],
  });
  await insert(OLD_VERSION, {
    generatorEvidence: { version: GENERATOR_EVIDENCE_VERSION + 1 },
    generatedImages: [{ blobs: [blob('old', 'sha-old')] }],
  });
  await insert(MALFORMED, {
    generatorEvidence: { version: GENERATOR_EVIDENCE_VERSION },
    generatedImages: [{ blobs: 'not an array' }],
  });
  await insert(NO_IMAGES, {
    generatorEvidence: { version: GENERATOR_EVIDENCE_VERSION },
    generatedImages: 'not an array',
  });
});

beforeEach(() => {
  views = [];
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
  dbMock.dbWrite.csamReport.findMany
    .mockReset()
    .mockResolvedValue(
      [CURRENT, EARLIER, OLD_VERSION, MALFORMED, NO_IMAGES].map((id) => ({ id })) as never
    );
  dbMock.dbWrite.modActivity.findMany
    .mockReset()
    .mockImplementation((async ({
      where,
    }: {
      where: { entityId: { in: number[] }; activity: { in: string[] } };
    }) =>
      views.filter(
        ({ entityId, activity }) =>
          where.entityId.in.includes(entityId) && where.activity.in.includes(activity)
      )) as never);
});

const current = { id: CURRENT, userId: USER };

describe('getViewedEvidence', () => {
  it('carries a view over from an earlier report that preserved the same bytes', async () => {
    view(EARLIER, 'same');
    const viewed = await getViewedEvidence(current, [{ blobId: 'same', sha256: 'sha-same' }]);
    expect(Object.fromEntries(viewed)).toEqual({ same: [MOD] });
  });

  it('does not carry a view over where the earlier bytes differ, were not preserved, or are unknown', async () => {
    view(EARLIER, 'changed');
    view(EARLIER, 'failed');
    view(EARLIER, 'unhashed');
    const viewed = await getViewedEvidence(current, [
      { blobId: 'changed', sha256: 'sha-after' },
      { blobId: 'failed', sha256: 'sha-failed' },
      { blobId: 'unhashed' },
    ]);
    expect(Object.fromEntries(viewed)).toEqual({});
  });

  it('does not carry a view over from a report of another evidence version', async () => {
    view(OLD_VERSION, 'old');
    const viewed = await getViewedEvidence(current, [{ blobId: 'old', sha256: 'sha-old' }]);
    expect(Object.fromEntries(viewed)).toEqual({});
  });

  it('marks nothing a moderator has not viewed, even with matching earlier bytes', async () => {
    view(EARLIER, 'same');
    const viewed = await getViewedEvidence(current, [
      { blobId: 'same', sha256: 'sha-same' },
      { blobId: 'unviewed', sha256: 'sha-unviewed' },
    ]);
    expect(Object.fromEntries(viewed)).toEqual({ same: [MOD] });
  });

  it('counts a view on this report without a hash check, beside malformed earlier reports', async () => {
    view(CURRENT, 'fresh', 901);
    view(MALFORMED, 'same');
    view(NO_IMAGES, 'same');
    view(EARLIER, 'same');
    const viewed = await getViewedEvidence(current, [
      { blobId: 'fresh' },
      { blobId: 'same', sha256: 'sha-same' },
    ]);
    expect(Object.fromEntries(viewed)).toEqual({ fresh: [901], same: [MOD] });
  });
});
