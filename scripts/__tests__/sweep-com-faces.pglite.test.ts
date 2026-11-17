import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

const db = new PGlite();
const raw = pgliteRaw(db);
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: (...args: Parameters<typeof raw.queryRaw>) => raw.queryRaw(...args) },
  dbWrite: {},
}));

import { readCandidates } from '../oneoffs/sweep-com-faces';

describe('sweep-com-faces candidates', () => {
  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE "Image" (id int PRIMARY KEY);
      CREATE TABLE "User" (id int PRIMARY KEY, "isModerator" boolean DEFAULT false);
      CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
      CREATE TABLE "ModActivity" (
        id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text,
        "entityId" int, "createdAt" timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE "Model" (
        id int PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, description text,
        nsfw boolean NOT NULL DEFAULT true, minor boolean NOT NULL DEFAULT false,
        poi boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
        "lockedProperties" text[], meta jsonb NOT NULL DEFAULT '{}',
        "sfwCoverImageId" int, "sfwName" text, "deletedAt" timestamp
      );
      INSERT INTO "Image" VALUES (10), (11), (12), (13), (14);
      INSERT INTO "Model" (id, "userId", name, "sfwCoverImageId", "sfwName", "deletedAt", meta) VALUES
        (1, 1, 'candidate', 10, 'com', NULL, '{}'),
        (2, 1, 'deleted', 11, 'com', now(), '{}'),
        (3, 1, 'has verdict', 12, 'com', NULL, '{"comFaceIntent": {"detected": false}}'),
        (4, 1, 'no com title', 13, NULL, NULL, '{}'),
        (5, 1, 'no face', NULL, 'com', NULL, '{}'),
        (6, 1, 'dangling cover', 99, 'com', NULL, '{}'),
        (7, 2, 'second candidate', 14, 'com', NULL, '{"other": 1}'),
        (8, 1, 'mod touched a version early', 10, 'com', NULL, '{}'),
        (9, 1, 'mod touched the model early', 10, 'com', NULL, '{}'),
        (10, 1, 'touched late, and by the system', 10, 'com', NULL, '{}');
      INSERT INTO "User" VALUES (50, true), (51, false), (-1, true);
      INSERT INTO "ModelVersion" VALUES (80, 8), (100, 10);
      INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt") VALUES
        (50, 'x', 'modelVersion', 80, '2026-09-01'),
        (50, 'x', 'Model', 9, '2026-10-20 23:59'),
        (50, 'x', 'model', 10, '2026-10-21 00:00'),
        (51, 'x', 'model', 7, '2026-09-01'),
        (-1, 'x', 'ModelVersion', 100, '2026-09-01'),
        (50, 'x', 'model', 1, '2026-11-01');
    `);
  });

  it('takes .com faces with no stored verdict, skipping deleted models and missing covers', async () => {
    const { candidates, dangling, faces } = await readCandidates(10, true);
    expect({ candidates, dangling, ids: faces.map((f) => f.id) }).toEqual({
      candidates: 5,
      dangling: 1,
      ids: [1, 7, 8, 9, 10],
    });
    expect(faces[0].lockedProperties).toEqual([]);
  });

  // Decision (Mod Lead ruling): any actor but the system counts, moderator now or not, up to
  // 2026-10-21, the day after logging deployed. A list entry beats a lock: don't narrow either.
  it('flags any non-system action on the model or a version before 2026-10-21 only', async () => {
    const { faces } = await readCandidates(10, true);
    expect(Object.fromEntries(faces.map((f) => [f.id, f.touchedBeforeLogging]))).toEqual({
      1: false,
      7: true,
      8: true,
      9: true,
      10: false,
    });
  });

  it('caps the batch at --limit', async () => {
    expect((await readCandidates(1, true)).faces.map((f) => f.id)).toEqual([1]);
    expect((await readCandidates(1, false)).faces).toHaveLength(1);
  });
});
