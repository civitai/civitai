import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Which models' file hashes the takedown-hash ledger offers, on the real SQL. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));

const { getTakedownHashCandidates } = await import('../takedown-hashes.service');

const SCHEMA = `
CREATE TABLE "Model" (
  id INTEGER PRIMARY KEY, status TEXT NOT NULL, "deletedAt" TIMESTAMP(3), meta JSONB
);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "ModelFile" (id INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "rawScanResult" JSONB);
`;

let pg: PGlite;
beforeEach(async () => {
  pg = await freshPglite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  await pg.exec(`
    INSERT INTO "Model" (id, status, "deletedAt", meta) VALUES
      (1, 'UnpublishedViolation', NULL, '{}'),
      (2, 'UnpublishedViolation', NULL, '{"removedWithOwner": true}'),
      (3, 'Published', now(), NULL),
      (4, 'Published', NULL, NULL);
    INSERT INTO "ModelVersion" (id, "modelId") SELECT id * 10, id FROM "Model";
    INSERT INTO "ModelFile" (id, "modelVersionId", "rawScanResult")
      SELECT id, id * 10, jsonb_build_object('hashes', jsonb_build_object('SHA256', 'H' || id))
      FROM "Model";
  `);
});

describe('getTakedownHashCandidates', () => {
  it('offers taken-down and deleted models, not one kept when its owner was wiped', async () => {
    const rows = await getTakedownHashCandidates();
    expect(rows.map((r) => r.modelId).sort()).toEqual([1, 3]);
  });
});
