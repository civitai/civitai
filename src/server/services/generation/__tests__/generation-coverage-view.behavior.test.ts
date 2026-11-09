import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Runs the `GenerationCoverage` view from the LAST migration that redefines it against an
 * in-process Postgres. The tables underneath are minimal stand-ins carrying only the columns the
 * view reads; the view body is the real one a human applies.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const VIEW_DDL = 'CREATE OR REPLACE VIEW "GenerationCoverage"';

function currentViewMigration() {
  const sqls = readdirSync(MIGRATIONS)
    .sort()
    .map((name) => {
      try {
        return readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .filter((sql) => sql.includes(VIEW_DDL));
  return sqls[sqls.length - 1];
}

const TABLES = `
CREATE TYPE "ModelUsageControl" AS ENUM ('Download', 'Generation', 'ExternalGeneration');
CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published');
CREATE TYPE "Availability" AS ENUM ('Public', 'Private');
CREATE TYPE "ModelUploadType" AS ENUM ('Created', 'Trained');
CREATE TYPE "CommercialUse" AS ENUM ('None', 'Image', 'RentCivit', 'Rent', 'Sell');
CREATE TYPE "ModelType" AS ENUM ('Checkpoint', 'LORA', 'TextualInversion', 'VAE', 'LoCon', 'DoRA', 'Upscaler');
CREATE TABLE "Model" (
  id INT PRIMARY KEY, poi BOOLEAN NOT NULL, availability "Availability" NOT NULL,
  "uploadType" "ModelUploadType" NOT NULL, "allowCommercialUse" "CommercialUse"[] NOT NULL,
  type "ModelType" NOT NULL, mode TEXT
);
CREATE TABLE "ModelVersion" (
  id INT PRIMARY KEY, "modelId" INT NOT NULL, "usageControl" "ModelUsageControl" NOT NULL,
  status "ModelStatus" NOT NULL, "baseModel" TEXT NOT NULL, "baseModelType" TEXT
);
CREATE TABLE "ModelFile" (
  id SERIAL PRIMARY KEY, "modelVersionId" INT NOT NULL, "scannedAt" TIMESTAMP, type TEXT NOT NULL,
  metadata JSONB
);
CREATE TABLE "EcosystemCheckpoints" (id INT);
CREATE TABLE "GenerationBaseModel" ("baseModel" TEXT);
CREATE TABLE "CoveredCheckpoint" (version_id INT);
INSERT INTO "GenerationBaseModel" VALUES ('SDXL 1.0');
`;

type SeedFile = { type: string; scanned?: boolean; metadata: unknown };

// Each version is a Draft trained SDXL LoRA, so only its files decide coverage.
const VERSIONS: Record<number, SeedFile[]> = {
  1: [{ type: 'Training Data', metadata: { trainingResults: { version: 2, epochs: [] } } }],
  2: [{ type: 'Training Data', metadata: { trainingResults: { epochs: null } } }],
  3: [{ type: 'Training Data', metadata: { trainingResults: { version: 2 } } }],
  4: [
    {
      type: 'Training Data',
      metadata: { trainingResults: { version: 2, epochs: [{ epochNumber: 1 }] } },
    },
  ],
  5: [{ type: 'Training Data', metadata: { trainingResults: { epochs: [{ epoch_number: 1 }] } } }],
  6: [
    { type: 'Training Data', metadata: { trainingResults: { version: 2, epochs: [] } } },
    { type: 'Model', scanned: true, metadata: { format: 'SafeTensor' } },
  ],
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(TABLES);
  for (const [id, files] of Object.entries(VERSIONS)) {
    await db.query(
      `INSERT INTO "Model" VALUES ($1, false, 'Private', 'Trained', ARRAY['RentCivit']::"CommercialUse"[], 'LORA', NULL)`,
      [id]
    );
    await db.query(
      `INSERT INTO "ModelVersion" VALUES ($1, $1, 'Download', 'Draft', 'SDXL 1.0', 'Standard')`,
      [id]
    );
    for (const file of files)
      await db.query(
        `INSERT INTO "ModelFile" ("modelVersionId", "scannedAt", type, metadata)
         VALUES ($1, CASE WHEN $2 THEN now() END, $3, $4)`,
        [id, file.scanned ?? false, file.type, file.metadata]
      );
  }
  await db.exec(currentViewMigration());
});

afterAll(() => db?.close());

async function coverage(versionId: number) {
  const { rows } = await db.query<{ covered: boolean; coveredNext: boolean }>(
    `SELECT covered, "coveredNext" FROM "GenerationCoverage" WHERE "modelVersionId" = $1`,
    [versionId]
  );
  return rows[0] ?? null;
}

describe('GenerationCoverage — trained files', () => {
  it.each([
    [1, 'a failed run (epochs: [])'],
    [2, 'a v1 result with epochs: null'],
    [3, 'a result with no epochs key'],
  ])('does not cover version %i, %s', async (versionId) => {
    expect(await coverage(versionId)).toBeNull();
  });

  it.each([
    [4, 'a v2 result with an epoch'],
    [5, 'a v1 result with an epoch'],
    [6, 'an empty-epochs zip beside a scanned model file'],
  ])('covers version %i under both rules, %s', async (versionId) => {
    expect(await coverage(versionId)).toEqual({ covered: true, coveredNext: true });
  });
});
