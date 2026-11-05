import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** The restricted-verdict leads in Needs review, read with their real SQL. Ids are invented. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// Only the reads run here; the ruling goes through the main app.
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
// Distinct bases, so the .com face link is seen to take the .com one.
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://com.test', CIVITAI_LINK_URL: 'https://red.test' },
}));

const { getRestrictedVerdictCount, getRestrictedVerdicts } = await import(
  '../restricted-nsfw-verdicts'
);

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_MIGRATION = readFileSync(
  join(
    HERE,
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261223120000_model_restricted_nsfw_verdict_idx/migration.sql'
  ),
  'utf-8'
);

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER,
      "nsfw" BOOLEAN NOT NULL DEFAULT false, "poi" BOOLEAN NOT NULL DEFAULT false,
      "minor" BOOLEAN NOT NULL DEFAULT false, "sfwOnly" BOOLEAN NOT NULL DEFAULT false,
      "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "meta" JSONB,
      "availability" TEXT NOT NULL DEFAULT 'Public', "sfwName" TEXT, "sfwCoverImageId" INTEGER);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "type" TEXT NOT NULL,
      "nsfwLevel" INTEGER NOT NULL);
    CREATE TABLE "EntityModeration" ("id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL,
      "entityId" INTEGER NOT NULL, "nsfwLevel" INTEGER, "triggeredLabels" TEXT[],
      "result" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now());
  `);
  // CONCURRENTLY cannot run in a transaction block; PGlite runs exec's statements as one.
  await db.exec(INDEX_MIGRATION.replace('CONCURRENTLY ', ''));
  await db.query(`INSERT INTO "User" ("id","username") VALUES (10,'owner')`);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  await (dbHandle.current as Kysely<unknown> | null)?.destroy();
  dbHandle.current = null;
  await db.close();
});

const lead = (restriction: string, at: string) => ({
  restrictedNsfwVerdict: { source: 'text-scan', at, restriction },
});

async function model(id: number, cols: Record<string, unknown>) {
  await db.query(
    `INSERT INTO "Model" (id, name, "userId", minor, poi, "sfwOnly", meta)
     VALUES ($1, $2, 10, $3, $4, $5, $6)`,
    [id, `M${id}`, !!cols.minor, !!cols.poi, !!cols.sfwOnly, cols.meta ?? null]
  );
}

describe('restricted-verdict leads', () => {
  it("gives each lead its model's civitai.com face, or null when it has none", async () => {
    await db.query(`INSERT INTO "Image" VALUES (900, 'com-cover', 'image', 2)`);
    await model(1, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-01T00:00:00Z') });
    await model(2, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-02T00:00:00Z') });
    await model(3, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-03T00:00:00Z') });
    await db.query(
      `UPDATE "Model" SET "sfwName" = 'com one', "sfwCoverImageId" = 900 WHERE id = 1`
    );
    await db.query(
      `UPDATE "Model" SET "sfwName" = 'com two', "sfwCoverImageId" = 999 WHERE id = 2`
    );
    // A cover id with the face off shows no face.
    await db.query(`UPDATE "Model" SET "sfwCoverImageId" = 900 WHERE id = 3`);

    const rows = await getRestrictedVerdicts();
    const face = (id: number) => rows.find((r) => r.modelId === id)?.comFace;

    expect(face(1)).toEqual({
      name: 'com one',
      url: 'https://com.test/models/1',
      cover: { id: 900, url: 'com-cover', type: 'image', nsfwLevel: 2 },
      coverPicked: true,
    });
    expect(face(2)).toEqual({
      name: 'com two',
      url: 'https://com.test/models/2',
      cover: null,
      coverPicked: true,
    });
    expect(face(3)).toBeNull();
    expect(rows[0]).not.toHaveProperty('sfwName');
  });

  it('lists minor first, then real person, then SFW-only, oldest first within each', async () => {
    await model(1, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-01T00:00:00Z') });
    await model(2, { poi: true, meta: lead('poi', '2026-11-03T00:00:00Z') });
    await model(3, { minor: true, meta: lead('minor', '2026-11-04T00:00:00Z') });
    await model(4, { minor: true, meta: lead('minor', '2026-11-02T00:00:00Z') });
    // Held as minor, owner unticked it since: still minor.
    await model(5, { sfwOnly: true, meta: lead('minor', '2026-11-05T00:00:00Z') });
    await model(6, { minor: true, meta: { other: true } }); // no lead
    await model(7, { minor: true }); // null meta
    // A verdict a moderator kept is not in the queue until it comes back as a lead.
    await model(8, {
      minor: true,
      meta: {
        restrictedNsfwVerdictDormant: lead('minor', '2026-11-01T00:00:00Z').restrictedNsfwVerdict,
      },
    });

    const rows = await getRestrictedVerdicts();
    expect(rows.map((r) => [r.modelId, r.restriction])).toEqual([
      [4, 'minor'],
      [3, 'minor'],
      [5, 'minor'],
      [2, 'poi'],
      [1, 'sfwOnly'],
    ]);
    expect(await getRestrictedVerdictCount()).toBe(5);
  });

  it('marks a lead held as minor or a real person whose owner has since unticked it', async () => {
    await model(1, { sfwOnly: true, meta: lead('minor', '2026-11-01T00:00:00Z') });
    await model(2, { meta: lead('poi', '2026-11-02T00:00:00Z') });
    await model(3, { poi: true, meta: lead('poi', '2026-11-03T00:00:00Z') });
    await model(4, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-04T00:00:00Z') });
    const rows = await getRestrictedVerdicts();
    expect(Object.fromEntries(rows.map((r) => [r.modelId, r.unticked]))).toEqual({
      1: true,
      2: true,
      3: false,
      4: false,
    });
  });

  it('marks an SFW-only lead whose lock a moderator lifted, so the note says who cleared it', async () => {
    const { restrictedNsfwVerdict } = lead('sfwOnly', '2026-11-01T00:00:00Z');
    await model(1, {
      meta: { restrictedNsfwVerdict: { ...restrictedNsfwVerdict, liftedBy: 'moderator' } },
    });
    await model(2, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-02T00:00:00Z') });
    const rows = await getRestrictedVerdicts();
    expect(Object.fromEntries(rows.map((r) => [r.modelId, r.unticked]))).toEqual({
      1: true,
      2: false,
    });
  });

  it('says who cleared the flag when it was not the owner', async () => {
    await model(1, { meta: lead('minor', '2026-11-01T00:00:00Z') });
    const lifted = (liftedBy: string) => ({
      restrictedNsfwVerdict: {
        ...lead('poi', '2026-11-02T00:00:00Z').restrictedNsfwVerdict,
        liftedBy,
      },
    });
    await model(2, { meta: lifted('moderator') });
    await model(3, { meta: lifted('hashRevert') });
    const rows = await getRestrictedVerdicts();
    expect(Object.fromEntries(rows.map((r) => [r.modelId, r.liftedBy]))).toEqual({
      1: null,
      2: 'moderator',
      3: 'hashRevert',
    });
  });

  it('marks a Private model, whose rating applies when it is published', async () => {
    await model(1, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-01T00:00:00Z') });
    await model(2, { sfwOnly: true, meta: lead('sfwOnly', '2026-11-02T00:00:00Z') });
    await db.query(`UPDATE "Model" SET availability = 'Private' WHERE id = 2`);
    const rows = await getRestrictedVerdicts();
    expect(Object.fromEntries(rows.map((r) => [r.modelId, r.isPrivate]))).toEqual({
      1: false,
      2: true,
    });
  });

  it("shows the scan's own verdict row next to the lead", async () => {
    await model(1, { minor: true, meta: lead('minor', '2026-11-01T00:00:00Z') });
    await db.query(
      `INSERT INTO "EntityModeration" ("entityType","entityId","nsfwLevel","triggeredLabels",result,"updatedAt")
       VALUES ('Model', 1, 4, '{nsfw}', '{"labels":{"nsfw":{"reason":"old"}}}', '2026-10-01'),
              ('Model', 1, 8, '{nsfw}', '{"labels":{"nsfw":{"reason":"new"}}}', '2026-11-01'),
              ('Article', 1, 16, '{nsfw}', '{"labels":{"nsfw":{"reason":"other"}}}', '2026-11-02')`
    );
    const [row] = await getRestrictedVerdicts();
    expect(row).toMatchObject({ scanLevel: 8, scanLabels: ['nsfw'], scanReason: 'new' });
  });
});
