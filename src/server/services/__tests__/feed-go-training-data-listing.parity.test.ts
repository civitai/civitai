import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import {
  TRAINING_DATA_LISTING_RULES_VERSION,
  trainingDataListing,
  trainingDataListingRulesId,
  trainingDataListingSql,
  trainingDataListingSqlSha256,
} from '~/server/services/training-data-restricted.service';

/**
 * feed-go answers `/api/v1/models` and `/api/v1/models/[id]` with Training Data files listed only
 * where `trainingDataListing` lists them. It reads the same rows with the statement in
 * apps/feed-go/internal/v1models/training_data_listing.sql and decides on them as this service does.
 * This file holds that statement to Node's: the same text as the builder renders (so a change to
 * ownerHeldSql, the report legs or the content restriction fails here until the file is re-rendered),
 * and, run on Postgres (PGlite, with the restriction migrations), the same rows as Node's for one
 * Training Data file per refusal reason. The predicate over the rows is pinned in Go
 * (internal/v1models/trainingdata_test.go) and by the golden fixtures. Its version, which feed-go also
 * requires to match, is held below to a hash of exactly: training-data-visibility.ts, the body of
 * `trainingDataListing` between its feed-go-rules markers, and the values of sfwBrowsingLevelsFlag and
 * ScanResultCode.Success. The call sites' inputs (isRedCapableHost in src/pages/api/v1/models/[id].ts
 * and in model-search.service.ts) are outside the hash. A bump that is not ported to feed-go passes
 * every check here: nothing compares the two decisions' behaviour beyond the goldens.
 *
 * The policy this pins is the dataset-sharing restriction as introduced with dataset sharing
 * (civitai/civitai#8193: `trainingDataListing`, `trainingDataOwnerRestrictedSql`,
 * `trainingDataContentRestrictedSql`, `trainingDataServableOnHost`) over the owner legal hold of
 * civitai/civitai#7047 (`ownerHeldSql`); #8274 made the listing skip versions read without files.
 * The CASES are one per leg of those builders, as they read today.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const GO_SQL = readFileSync(
  path.resolve(__dirname, '../../../../apps/feed-go/internal/v1models/training_data_listing.sql'),
  'utf8'
);
const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');

// The tables the statement reads, as training-data-share.behavior.test.ts declares them.
const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Model" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    poi boolean NOT NULL DEFAULT false,
    minor boolean NOT NULL DEFAULT false,
    "tosViolation" boolean NOT NULL DEFAULT false,
    meta jsonb
  );
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
  CREATE TABLE "ModelFile" (
    id int PRIMARY KEY,
    "modelVersionId" int NOT NULL,
    type text NOT NULL,
    metadata jsonb,
    "virusScanResult" text NOT NULL DEFAULT 'Pending'
  );
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
`;

/**
 * One owner, model, version, post, post image and Training Data file per case (ids offset by the
 * case's index), then the case's own state. `restricted` is what the statement must compute.
 */
type Case = { name: string; owner?: number; setup?: (k: Ids) => string; restricted: boolean };
type Ids = {
  owner: number;
  model: number;
  version: number;
  post: number;
  image: number;
  file: number;
};
const CASES: Case[] = [
  { name: 'clean owner and content', restricted: false },
  {
    name: 'a rated dataset (its jsonb rating read back as JSON values)',
    setup: (k) =>
      `UPDATE "ModelFile" SET metadata = '{"nsfwLevel": 4, "fullyRated": false}' WHERE id = ${k.file}`,
    restricted: false,
  },
  { name: 'the placeholder owner', owner: -1, restricted: true },
  {
    name: 'an owner with a hold marker',
    setup: (k) =>
      `INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${k.owner}, 'manual', 'test')`,
    restricted: true,
  },
  {
    name: 'an owner named on a holding report',
    setup: (k) => `INSERT INTO "CsamReport" ("userId") VALUES (${k.owner})`,
    restricted: true,
  },
  {
    name: 'an owner named on a report past its hold (any report restricts sharing)',
    setup: (k) =>
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
       VALUES (${k.owner}, now() - interval '2 years', now() - interval '1 year')`,
    restricted: true,
  },
  {
    name: "an owner named as a report's secondary user",
    setup: (k) =>
      `INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{"secondaryUserId": ${k.owner}}')`,
    restricted: true,
  },
  {
    name: 'an owner with an image under CSAM review elsewhere',
    setup: (k) =>
      `INSERT INTO "Image" (id, "userId", "needsReview") VALUES (${k.image + 5000}, ${
        k.owner
      }, 'csam')`,
    restricted: true,
  },
  {
    name: 'a POI model',
    setup: (k) => `UPDATE "Model" SET poi = true WHERE id = ${k.model}`,
    restricted: true,
  },
  {
    name: 'a minor model',
    setup: (k) => `UPDATE "Model" SET minor = true WHERE id = ${k.model}`,
    restricted: true,
  },
  {
    name: 'a ToS-violation model',
    setup: (k) => `UPDATE "Model" SET "tosViolation" = true WHERE id = ${k.model}`,
    restricted: true,
  },
  {
    name: 'a post image that needs review',
    setup: (k) => `UPDATE "Image" SET "needsReview" = 'other' WHERE id = ${k.image}`,
    restricted: true,
  },
  {
    name: 'a blocked post image',
    setup: (k) => `UPDATE "Image" SET "blockedFor" = 'moderated' WHERE id = ${k.image}`,
    restricted: true,
  },
  {
    name: 'a post image with ingestion Blocked',
    setup: (k) => `UPDATE "Image" SET ingestion = 'Blocked' WHERE id = ${k.image}`,
    restricted: true,
  },
];

const idsOf = (i: number, c: Case): Ids => ({
  owner: c.owner ?? 1000 + i,
  model: 100 + i,
  version: 100 + i,
  post: 200 + i,
  image: 300 + i,
  file: 400 + i,
});

let db: PGlite;
let queryError: unknown;
const client = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    captured.push({ text: sql.text, values: sql.values });
    try {
      const rows = (await db.query(sql.text, sql.values)).rows;
      nodeRows.push(...(rows as Record<string, unknown>[]));
      return rows;
    } catch (e) {
      queryError = e;
      throw e;
    }
  },
} as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
let captured: { text: string; values: unknown[] }[] = [];
let nodeRows: Record<string, unknown>[] = [];

const versions = () =>
  CASES.map((c, i) => {
    const k = idsOf(i, c);
    return { id: k.version, files: [{ id: k.file, type: 'Training Data', visibility: 'Public' }] };
  });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(migration('20261019220000_evidence_hold'));
  await db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
  await db.exec(migration('20261227150000_evidence_hold_owner_held'));
  for (const [i, c] of CASES.entries()) {
    const k = idsOf(i, c);
    await db.exec(`
      INSERT INTO "Model" (id, "userId") VALUES (${k.model}, ${k.owner});
      INSERT INTO "ModelVersion" (id, "modelId") VALUES (${k.version}, ${k.model});
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (${k.post}, ${k.owner}, ${k.version});
      INSERT INTO "Image" (id, "userId", "postId") VALUES (${k.image}, ${k.owner}, ${k.post});
      INSERT INTO "ModelFile" VALUES (${k.file}, ${k.version}, 'Training Data', '{}', 'Success');
    `);
    if (c.setup) await db.exec(c.setup(k));
  }
});
afterAll(async () => {
  await db?.close();
});

// What TRAINING_DATA_LISTING_RULES_VERSION versions (see the docblock for what is and is not in it). Each version is recorded with the SHA-256 of that source; a change to it fails here until
// the version is bumped (here, in the service and in feed-go) and the new hash recorded, and feed-go
// falls back for a Node that sends a version it does not have.
const RULES_SOURCE_SHA256: Record<number, string> = {
  1: '27f8827e0fcef8aa29249cc65057f1f4dac0719ce1680d79878483e430b66fad',
  // 2: trainingDataListings (one read, the decision for this host and for a red-capable one).
  2: '74438f82a4c2bf886a0322aeccdb259c9a69759f6d45b1e6d355c76153a81946',
};
const SERVICE = path.resolve(__dirname, '../training-data-restricted.service.ts');
const VISIBILITY = path.resolve(__dirname, '../../../shared/utils/training-data-visibility.ts');
const GO_TRAINING_DATA = path.resolve(
  __dirname,
  '../../../../apps/feed-go/internal/v1models/trainingdata.go'
);

/** The marked decision block of trainingDataListing and the whole visibility module. */
function rulesSource() {
  const svc = readFileSync(SERVICE, 'utf8');
  const count = (marker: string) => svc.split(marker).length - 1;
  if (count('// feed-go-rules:begin') !== 1 || count('// feed-go-rules:end') !== 1)
    throw new Error('want exactly one feed-go-rules:begin and one feed-go-rules:end marker');
  const begin = svc.indexOf('// feed-go-rules:begin');
  const end = svc.indexOf('// feed-go-rules:end');
  if (end < begin) throw new Error('feed-go-rules:end precedes feed-go-rules:begin');
  return [
    readFileSync(VISIBILITY, 'utf8'),
    svc.slice(begin, end),
    `sfwBrowsingLevelsFlag=${sfwBrowsingLevelsFlag}`,
    `ScanResultCode.Success=${ScanResultCode.Success}`,
  ].join('\0');
}

describe("feed-go's training data decision version", () => {
  it('is bumped whenever the decision source changes', () => {
    const sha = createHash('sha256').update(rulesSource()).digest('hex');
    expect(
      RULES_SOURCE_SHA256[TRAINING_DATA_LISTING_RULES_VERSION],
      `The Training Data decision (training-data-visibility.ts, trainingDataListing's ` +
        `feed-go-rules body, sfwBrowsingLevelsFlag or ScanResultCode.Success) changed: bump ` +
        `TRAINING_DATA_LISTING_RULES_VERSION and feed-go's TrainingDataRulesVersion, port the change ` +
        `to apps/feed-go/internal/v1models/trainingdata.go, check the call sites outside this hash ` +
        `(isRedCapableHost in src/pages/api/v1/models/[id].ts and model-search.service.ts, and ` +
        `feed-go's redCapable), and record ${
          TRAINING_DATA_LISTING_RULES_VERSION + 1
        }: '${sha}' here.`
    ).toBe(sha);
  });

  it("is feed-go's, and is what the sampler sends", () => {
    const go = /^const TrainingDataRulesVersion = (\d+)$/m.exec(
      readFileSync(GO_TRAINING_DATA, 'utf8')
    );
    expect(go?.[1], 'TrainingDataRulesVersion in trainingdata.go').toBe(
      String(TRAINING_DATA_LISTING_RULES_VERSION)
    );
    expect(trainingDataListingRulesId()).toBe(
      `${trainingDataListingSqlSha256()};rules=${TRAINING_DATA_LISTING_RULES_VERSION}`
    );
  });
});

describe("feed-go's training data statement", () => {
  it("is Node's statement, text and values", async () => {
    captured = [];
    nodeRows = [];
    await trainingDataListing(client, versions(), { redCapable: false });
    expect(queryError).toBeUndefined();
    expect(captured).toHaveLength(1);
    // Exact bytes: feed-go hashes its copy and compares the hash Node sends with each sample.
    expect(GO_SQL).toBe(captured[0].text);
    expect(captured[0].text).toBe(trainingDataListingSql([]).text);
    expect(captured[0].values).toEqual([versions().map((v) => v.id)]);
    expect(createHash('sha256').update(GO_SQL).digest('hex')).toBe(trainingDataListingSqlSha256());
  });

  it('computes each refusal reason as Node does, on Postgres', async () => {
    captured = [];
    nodeRows = [];
    const candidates = versions().map((v) => v.id);
    await trainingDataListing(client, versions(), { redCapable: true });
    expect(queryError).toBeUndefined();
    const goRows = (await db.query(GO_SQL, [candidates])).rows as Record<string, unknown>[];
    const byId = (rows: Record<string, unknown>[]) =>
      Object.fromEntries(rows.map((r) => [r.id as number, r]));
    // Every case's file has a row, and the two statements agree on every column of every row.
    expect(goRows).toHaveLength(CASES.length);
    expect(byId(goRows)).toEqual(byId(nodeRows));
    for (const [i, c] of CASES.entries()) {
      const row = byId(goRows)[idsOf(i, c).file];
      expect({ case: c.name, restricted: row.restricted }).toEqual({
        case: c.name,
        restricted: c.restricted,
      });
    }
    // The rating columns arrive as the JSON values Go's predicate reads (a number, a boolean).
    const rated = byId(goRows)[idsOf(1, CASES[1]).file];
    expect([rated.nsfwLevel, rated.fullyRated, rated.virusScanResult]).toEqual([
      4,
      false,
      'Success',
    ]);
    // And Node lists exactly the files whose rows are not restricted (scan Success, red host).
    const listed = await trainingDataListing(client, versions(), { redCapable: true });
    for (const [i, c] of CASES.entries()) {
      const k = idsOf(i, c);
      expect({
        case: c.name,
        listed: listed({ id: k.file, type: 'Training Data', visibility: 'Public' }),
      }).toEqual({ case: c.name, listed: !c.restricted });
    }
  });
});
