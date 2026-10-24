import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AutoFeatureCandidate } from '~/server/services/auto-feature-images.service';
import {
  buildCandidatesQuery,
  selectAutoFeaturePicks,
} from '~/server/services/auto-feature-images.service';
import type { AutoFeatureSchema } from '~/server/schema/home-block.schema';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SOURCE = 1;
const TARGET = 107;
const REVIVED = 10; // popular a month ago, re-curated an hour ago
const FRESH = 20; // curated two hours ago, reacted to since

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "nsfwLevel" int NOT NULL,
      ingestion text NOT NULL,
      poi boolean NOT NULL,
      minor boolean NOT NULL,
      "needsReview" text
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY,
      "collectionId" int NOT NULL,
      "imageId" int,
      status text NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      "reviewedAt" timestamp(3)
    );
    CREATE TABLE "ImageReaction" (
      id serial PRIMARY KEY,
      "imageId" int NOT NULL,
      "createdAt" timestamp(3) NOT NULL
    );

    INSERT INTO "User" (id) VALUES (1), (2);
    INSERT INTO "Image" (id, "userId", "nsfwLevel", ingestion, poi, minor) VALUES
      (${REVIVED}, 1, 1, 'Scanned', false, false),
      (${FRESH}, 2, 1, 'Scanned', false, false);

    -- Submitted long ago, accepted (curated) an hour ago: curatedAt = reviewedAt.
    INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "createdAt", "reviewedAt") VALUES
      (${SOURCE}, ${REVIVED}, 'ACCEPTED', now() - interval '40 days', now() - interval '1 hour'),
      (${SOURCE}, ${FRESH}, 'ACCEPTED', now() - interval '2 hours', NULL);

    -- REVIVED: 200 reactions from a month ago, 5 inside the candidate window but before it was
    -- curated (a cutoff of "the last N days" would wrongly count these), one at the exact moment
    -- of curation (the boundary is inclusive), and 3 since.
    INSERT INTO "ImageReaction" ("imageId", "createdAt")
      SELECT ${REVIVED}, now() - interval '30 days' FROM generate_series(1, 200);
    INSERT INTO "ImageReaction" ("imageId", "createdAt")
      SELECT ${REVIVED}, now() - interval '2 hours' FROM generate_series(1, 5);
    INSERT INTO "ImageReaction" ("imageId", "createdAt") VALUES (${REVIVED}, now() - interval '1 hour');
    INSERT INTO "ImageReaction" ("imageId", "createdAt")
      SELECT ${REVIVED}, now() - interval '30 minutes' FROM generate_series(1, 3);
    -- FRESH: 20 reactions, all after it was curated.
    INSERT INTO "ImageReaction" ("imageId", "createdAt")
      SELECT ${FRESH}, now() - interval '1 hour' FROM generate_series(1, 20);
  `);
});

afterAll(async () => {
  await db?.close();
});

const fetchCandidates = async (): Promise<AutoFeatureCandidate[]> => {
  const query = buildCandidatesQuery({
    collectionIds: [SOURCE],
    targetCollectionId: TARGET,
    windowDays: 7,
  });
  const { rows } = await db.query<{
    imageId: number;
    userId: number;
    collectionId: number;
    curatedAt: Date;
    reactions: bigint | number;
  }>(query.text, query.values as unknown[]);
  return rows.map((r) => ({ ...r, reactions: Number(r.reactions) }));
};

const config: AutoFeatureSchema = {
  collectionId: TARGET,
  dryRun: false,
  perRun: 1,
  intervalHours: 6,
  windowDays: 7,
  capWindowDays: 7,
  recencyOffsetHours: 12,
  decayExponent: 0.8,
  maxPerCreatorPerRun: 1,
  maxPerCreatorInWindow: 2,
  maxPerCollectionInWindow: undefined,
  minReactions: 0,
  strategy: 'global',
};

describe('auto-feature candidates count only reactions since curation', () => {
  it('counts each image’s reactions from its curatedAt, not over its whole life', async () => {
    const byId = new Map((await fetchCandidates()).map((c) => [c.imageId, c.reactions]));

    expect(Object.fromEntries(byId)).toEqual({ [REVIVED]: 4, [FRESH]: 20 });
  });

  it('does not let a re-curated old image outrank a new one on its old reactions', async () => {
    const { picks } = selectAutoFeaturePicks({
      candidates: await fetchCandidates(),
      config,
      now: new Date(),
      creatorCounts: new Map(),
      collectionCounts: new Map(),
      rotationOffset: 0,
    });

    expect(picks.map((p) => p.imageId)).toEqual([FRESH]);
  });
});
