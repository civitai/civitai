import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The GenerationCoverage view in force (the last migration that defines it) run against real rows:
 * a version with a file whose scan found danger, or a loadable file whose scan errored, is not
 * covered, under any arm. An errored file the generator never loads leaves the version covered, and
 * Pending is deliberately left covered: it holds unscanned files and trained models' results. Ids are
 * invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const VIEW_DDL = 'CREATE OR REPLACE VIEW "GenerationCoverage"';

function currentViewSql() {
  const sql = readdirSync(MIGRATIONS)
    .sort()
    .map((name) => {
      try {
        return readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .filter((text) => text.includes(VIEW_DDL))
    .pop();
  if (!sql) throw new Error('no migration defines GenerationCoverage');
  return sql;
}

const SCHEMA = `
  CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'Deleted');
  CREATE TYPE "ModelUsageControl" AS ENUM ('Download', 'Generation', 'InternalGeneration', 'ExternalGeneration');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Private', 'Unsearchable', 'EarlyAccess');
  CREATE TYPE "ModelUploadType" AS ENUM ('Created', 'Trained');
  CREATE TYPE "CommercialUse" AS ENUM ('None', 'Image', 'RentCivit', 'Rent', 'Sell');
  CREATE TYPE "ModelType" AS ENUM ('Checkpoint', 'TextualInversion', 'LORA', 'LoCon', 'DoRA', 'VAE', 'Upscaler');
  CREATE TYPE "ScanResultCode" AS ENUM ('Pending', 'Success', 'Danger', 'Error');
  CREATE TABLE "Model" (
    id int PRIMARY KEY, poi boolean NOT NULL DEFAULT false, availability "Availability" NOT NULL DEFAULT 'Public',
    "uploadType" "ModelUploadType" NOT NULL DEFAULT 'Created',
    "allowCommercialUse" "CommercialUse"[] NOT NULL DEFAULT ARRAY['RentCivit'::"CommercialUse"],
    type "ModelType" NOT NULL DEFAULT 'LORA', mode text
  );
  CREATE TABLE "ModelVersion" (
    id int PRIMARY KEY, "modelId" int NOT NULL, "usageControl" "ModelUsageControl" NOT NULL DEFAULT 'Download',
    status "ModelStatus" NOT NULL DEFAULT 'Published', "baseModel" text NOT NULL DEFAULT 'SDXL 1.0',
    "baseModelType" text DEFAULT 'Standard'
  );
  CREATE TABLE "ModelFile" (
    id serial PRIMARY KEY, "modelVersionId" int NOT NULL, "scannedAt" timestamp DEFAULT now(),
    type text NOT NULL DEFAULT 'Model', metadata jsonb DEFAULT '{"format":"SafeTensor"}',
    "pickleScanResult" "ScanResultCode" NOT NULL DEFAULT 'Success',
    "virusScanResult" "ScanResultCode" NOT NULL DEFAULT 'Success'
  );
  CREATE TABLE "EcosystemCheckpoints" (id int);
  CREATE TABLE "CoveredCheckpoint" (version_id int);
  CREATE TABLE "GenerationBaseModel" ("baseModel" text);
  INSERT INTO "GenerationBaseModel" VALUES ('SDXL 1.0');
`;

// One model and version per case, so each id answers for exactly one file row.
const CLEAN = 1;
const PICKLE_DANGER = 2;
const VIRUS_DANGER = 3;
const PICKLE_ERROR = 4;
const ECOSYSTEM_DANGER = 5;
const TRAINED_DANGER = 6;
const DANGER_BESIDE_CLEAN = 7;
const VIRUS_ERROR = 8;
const PENDING = 9;
const TRAINED_PENDING = 10;
// Beside a clean weight file, so only the second file decides.
const CONFIG_ERROR = 11;
const CONFIG_DANGER = 12;
const LAST_ID = 12;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  for (let id = 1; id <= LAST_ID; id++) {
    await db.query(`INSERT INTO "Model" (id) VALUES ($1)`, [id]);
    await db.query(`INSERT INTO "ModelVersion" (id, "modelId") VALUES ($1, $1)`, [id]);
  }
  const file = (
    versionId: number,
    pickle: string,
    virus = 'Success',
    metadata?: string,
    type = 'Model'
  ) =>
    db.query(
      `INSERT INTO "ModelFile" ("modelVersionId", "pickleScanResult", "virusScanResult", metadata, type)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '{"format":"SafeTensor"}'), $5)`,
      [versionId, pickle, virus, metadata ?? null, type]
    );
  await file(CLEAN, 'Success');
  await file(PICKLE_DANGER, 'Danger');
  await file(VIRUS_DANGER, 'Success', 'Danger');
  await file(PICKLE_ERROR, 'Error');
  await file(ECOSYSTEM_DANGER, 'Danger');
  await db.query(`INSERT INTO "EcosystemCheckpoints" VALUES ($1)`, [ECOSYSTEM_DANGER]);
  await file(TRAINED_DANGER, 'Danger', 'Success', '{"trainingResults":{}}');
  await file(DANGER_BESIDE_CLEAN, 'Success');
  await file(DANGER_BESIDE_CLEAN, 'Danger');
  await file(VIRUS_ERROR, 'Success', 'Error');
  await file(PENDING, 'Pending', 'Pending');
  await file(TRAINED_PENDING, 'Pending', 'Pending', '{"trainingResults":{}}');
  await file(CONFIG_ERROR, 'Success');
  await file(CONFIG_ERROR, 'Error', 'Success', undefined, 'Config');
  await file(CONFIG_DANGER, 'Success');
  await file(CONFIG_DANGER, 'Danger', 'Success', undefined, 'Config');

  await db.exec(currentViewSql());
});

afterAll(async () => {
  await db?.close();
});

describe('GenerationCoverage and failed scans', () => {
  it('covers no version with a Danger file or an errored loadable file; Pending and an errored config stay covered', async () => {
    const { rows } = await db.query<{ modelVersionId: number }>(
      `SELECT "modelVersionId" FROM "GenerationCoverage" WHERE covered OR "coveredNext" ORDER BY 1`
    );
    expect(rows.map((r) => r.modelVersionId)).toEqual([
      CLEAN,
      PENDING,
      TRAINED_PENDING,
      CONFIG_ERROR,
    ]);
  });
});
