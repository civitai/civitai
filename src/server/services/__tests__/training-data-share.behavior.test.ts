import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import {
  trainingDataListing,
  trainingDataShareHeld,
} from '~/server/services/training-data-held.service';

/** A training dataset is shared only while neither its owner nor its content is held. Runs the
 *  real hold migrations on PGlite; each case runs in a transaction that is rolled back. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');

const PLAIN = 1; // no hold of any kind
const MARKER = 2; // an active hold marker
const OLD_REPORT = 3; // named on a report sent two years ago and archived

// One model + version per owner, ids offset from the owner's.
const versionOf = (uid: number) => 100 + uid;

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
    "tosViolation" boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
  CREATE TABLE "ModelFile" (
    id int PRIMARY KEY,
    "modelVersionId" int NOT NULL,
    type text NOT NULL,
    metadata jsonb
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

const OWNERS = [PLAIN, MARKER, OLD_REPORT];
const FIXTURE = `
  INSERT INTO "Model" (id, "userId") SELECT 100 + u, u FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
  INSERT INTO "ModelVersion" (id, "modelId") SELECT 100 + u, 100 + u FROM unnest(ARRAY[${OWNERS.join(
    ','
  )}]) u;
  INSERT INTO "Post" (id, "userId", "modelVersionId") SELECT 200 + u, u, 100 + u FROM unnest(ARRAY[${OWNERS.join(
    ','
  )}]) u;
  INSERT INTO "Image" (id, "userId", "postId") SELECT 300 + u, u, 200 + u FROM unnest(ARRAY[${OWNERS.join(
    ','
  )}]) u;
  INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKER}, 'manual', 'test');
  INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
    VALUES (${OLD_REPORT}, now() - interval '2 years', now() - interval '1 year');
`;

let db: PGlite;
// `$queryRaw` is a tagged template; a query that throws would read as held (fail closed), so the
// adapter rethrows loudly instead of letting every "held" case pass on an error.
let queryError: unknown;
const client = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    try {
      return (await db.query(sql.text, sql.values)).rows;
    } catch (e) {
      queryError = e;
      throw e;
    }
  },
} as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
const held = (uid: number) => trainingDataShareHeld(client, versionOf(uid));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(migration('20261019220000_evidence_hold'));
  await db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
  await db.exec(migration('20261227150000_evidence_hold_owner_held'));
  await db.exec(FIXTURE);
});
beforeEach(async () => {
  queryError = undefined;
  await db.exec('BEGIN');
});
afterEach(async () => {
  await db.exec('ROLLBACK');
  expect(queryError).toBeUndefined();
});

describe('trainingDataShareHeld', () => {
  it('a clean owner and clean content can share', async () => {
    expect(await held(PLAIN)).toBe(false);
  });

  it('an owner the content hold keeps cannot share', async () => {
    expect(await held(MARKER)).toBe(true);
  });

  it('an owner named on any report cannot share, however old the report', async () => {
    // The content hold has let this owner go; sharing does not.
    const { rows } = await db.query<{ held: boolean }>(
      `SELECT ${ownerHeldSql(Prisma.raw(String(OLD_REPORT))).text} AS held`
    );
    expect(rows[0].held).toBe(false);
    expect(await held(OLD_REPORT)).toBe(true);
  });

  it('reads a hold placed after the dataset went public', async () => {
    expect(await held(PLAIN)).toBe(false);
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${PLAIN})`);
    expect(await held(PLAIN)).toBe(true);
  });

  it('an owner named only as the second user on a report cannot share', async () => {
    await db.exec(
      `INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{"secondaryUserId": ${PLAIN}}')`
    );
    expect(await held(PLAIN)).toBe(true);
  });

  it.each([
    ['poi', `UPDATE "Model" SET poi = true WHERE id = 101`],
    ['minor', `UPDATE "Model" SET minor = true WHERE id = 101`],
    ['tosViolation', `UPDATE "Model" SET "tosViolation" = true WHERE id = 101`],
    ['an image needing review', `UPDATE "Image" SET "needsReview" = 'other' WHERE id = 301`],
    [
      'a blocked image',
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = 301`,
    ],
  ])('content held by %s cannot share', async (_, sql) => {
    await db.exec(sql);
    expect(await held(PLAIN)).toBe(true);
  });

  it('fails closed when the check cannot be read', async () => {
    const broken = {
      $queryRaw: async () => {
        throw new Error('down');
      },
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
    expect(await trainingDataShareHeld(broken, versionOf(PLAIN))).toBe(true);
  });
});

describe('trainingDataListing', () => {
  // Each owner's version has a shared dataset rated PG (file 400 + uid) and a model file.
  const datasetOf = (uid: number) => ({
    id: 400 + uid,
    type: 'Training Data',
    visibility: 'Public',
  });
  const modelOf = (uid: number) => ({ id: 500 + uid, type: 'Model', visibility: 'Public' });
  const rate = (uid: number, metadata: object) =>
    db.exec(
      `INSERT INTO "ModelFile" VALUES (${400 + uid}, ${versionOf(
        uid
      )}, 'Training Data', '${JSON.stringify(metadata)}')`
    );
  const listedFor = async (
    uid: number,
    { redCapable = false, viewerManages = false, c = client } = {}
  ) => {
    const listed = await trainingDataListing(
      c,
      [{ id: versionOf(uid), files: [datasetOf(uid), modelOf(uid)] }],
      { redCapable, viewerManages }
    );
    return [listed(datasetOf(uid)), listed(modelOf(uid))];
  };

  it('lists a shared PG dataset while nothing is held', async () => {
    await rate(PLAIN, { nsfwLevel: 1 });
    expect(await listedFor(PLAIN)).toEqual([true, true]);
  });

  it('a report on the owner after sharing unlists the dataset, and only the dataset', async () => {
    await rate(PLAIN, { nsfwLevel: 1 });
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${PLAIN})`);
    expect(await listedFor(PLAIN)).toEqual([false, true]);
    // The owner and moderators still see it.
    expect(await listedFor(PLAIN, { viewerManages: true })).toEqual([true, true]);
  });

  it('checks each version on its own', async () => {
    await rate(PLAIN, { nsfwLevel: 1 });
    await rate(MARKER, { nsfwLevel: 1 });
    const listed = await trainingDataListing(
      client,
      [
        { id: versionOf(PLAIN), files: [datasetOf(PLAIN)] },
        { id: versionOf(MARKER), files: [datasetOf(MARKER)] },
      ],
      { redCapable: false }
    );
    expect([listed(datasetOf(PLAIN)), listed(datasetOf(MARKER))]).toEqual([true, false]);
  });

  it.each([
    ['a mature dataset', { nsfwLevel: 4 | 1 }, false, false],
    ['a mature dataset', { nsfwLevel: 4 | 1 }, true, true],
    ['an unrated dataset', {}, false, false],
    ['an unrated dataset', {}, true, true],
  ])('%s on a red-capable host %s is listed: %s', async (_, metadata, redCapable, expected) => {
    await rate(PLAIN, metadata);
    expect(await listedFor(PLAIN, { redCapable })).toEqual([expected, true]);
    // Off .red the owner is not offered it either: the download would refuse them too.
    expect(await listedFor(PLAIN, { redCapable, viewerManages: true })).toEqual([expected, true]);
  });

  it('unlists every dataset when the check cannot be read', async () => {
    const broken = {
      $queryRaw: () => Promise.reject(new Error('down')),
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
    expect(await listedFor(PLAIN, { redCapable: true, c: broken })).toEqual([false, true]);
  });
});
