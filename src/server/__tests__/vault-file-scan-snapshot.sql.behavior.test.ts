import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The ModelFile delete trigger, run as written against an in-process Postgres. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../packages/civitai-db-schema/prisma/migrations/20271113120000_vault_file_scan_snapshot/migration.sql'
);
const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "ScanResultCode" AS ENUM ('Pending', 'Success', 'Danger', 'Error');
    CREATE TABLE "Model" ("id" integer PRIMARY KEY);
    CREATE TABLE "ModelVersion" (
      "id" integer PRIMARY KEY,
      "modelId" integer NOT NULL REFERENCES "Model"("id") ON DELETE CASCADE
    );
    CREATE TABLE "ModelFile" (
      "id" integer PRIMARY KEY,
      "url" text NOT NULL,
      "modelVersionId" integer NOT NULL REFERENCES "ModelVersion"("id") ON DELETE CASCADE,
      "pickleScanResult" "ScanResultCode" NOT NULL DEFAULT 'Pending',
      "virusScanResult" "ScanResultCode" NOT NULL DEFAULT 'Pending'
    );
    CREATE TABLE "VaultItem" (
      "id" integer PRIMARY KEY,
      "modelVersionId" integer NOT NULL,
      "files" jsonb NOT NULL DEFAULT '[]'
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg?.close();
});

const entry = (id: number) => ({ id, sizeKB: 1, url: `files/${id}`, displayName: `f${id}` });

beforeEach(async () => {
  await db.pg.exec(`
    DELETE FROM "VaultItem"; DELETE FROM "ModelFile"; DELETE FROM "ModelVersion"; DELETE FROM "Model";
    INSERT INTO "Model" VALUES (1), (2);
    INSERT INTO "ModelVersion" VALUES (10, 1), (20, 2);
    INSERT INTO "ModelFile" VALUES
      (101, 'files/101', 10, 'Success', 'Success'),
      (102, 'files/102', 10, 'Success', 'Danger'),
      (103, 'files/103', 10, 'Danger', 'Success'),
      (201, 'files/201', 20, 'Success', 'Danger');
  `);
  // Two users vaulted version 10, one with the entries in a different order; version 20 is not vaulted.
  await db.pg.query(`INSERT INTO "VaultItem" VALUES (1, 10, $1), (2, 10, $2)`, [
    JSON.stringify([entry(101), entry(102), entry(103)]),
    JSON.stringify([entry(103), entry(101), entry(102)]),
  ]);
});

const filesOf = async (id: number) =>
  (
    await db.pg.query<{ files: Record<string, unknown>[] }>(
      `SELECT files FROM "VaultItem" WHERE id = $1`,
      [id]
    )
  ).rows[0].files;

describe('ModelFile delete -> VaultItem.files scan snapshot', () => {
  it('stamps only the deleted file and keeps the other entries and their order', async () => {
    await db.pg.exec(`DELETE FROM "ModelFile" WHERE id = 102`);
    expect(await filesOf(1)).toEqual([
      entry(101),
      { ...entry(102), pickleScanResult: 'Success', virusScanResult: 'Danger' },
      entry(103),
    ]);
    expect(await filesOf(2)).toEqual([
      entry(103),
      entry(101),
      { ...entry(102), pickleScanResult: 'Success', virusScanResult: 'Danger' },
    ]);
  });

  it('stamps all N files of every vaulted copy when the Model is deleted (cascade)', async () => {
    await db.pg.exec(`DELETE FROM "Model" WHERE id = 1`);
    expect(
      (await db.pg.query(`SELECT 1 FROM "ModelFile" WHERE "modelVersionId" = 10`)).rows
    ).toEqual([]);
    const stamped = {
      101: { pickleScanResult: 'Success', virusScanResult: 'Success' },
      102: { pickleScanResult: 'Success', virusScanResult: 'Danger' },
      103: { pickleScanResult: 'Danger', virusScanResult: 'Success' },
    };
    for (const item of [1, 2]) {
      const files = await filesOf(item);
      expect(files).toHaveLength(3);
      for (const f of files)
        expect(f).toEqual({ ...entry(f.id as number), ...stamped[f.id as 101 | 102 | 103] });
    }
  });

  it('changes no vault row when the deleted file was never vaulted', async () => {
    const before = (await db.pg.query(`SELECT id, files FROM "VaultItem" ORDER BY id`)).rows;
    await db.pg.exec(`DELETE FROM "Model" WHERE id = 2`);
    expect((await db.pg.query(`SELECT id, files FROM "VaultItem" ORDER BY id`)).rows).toEqual(
      before
    );
  });

  it('runs as the caller with a fixed search_path', async () => {
    const { rows } = await db.pg.query<{ prosecdef: boolean; proconfig: string[] }>(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'vault_item_snapshot_file_scan'`
    );
    expect(rows).toEqual([{ prosecdef: false, proconfig: ['search_path=pg_catalog, public'] }]);
  });
});
