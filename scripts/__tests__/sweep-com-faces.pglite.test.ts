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
        (7, 2, 'second candidate', 14, 'com', NULL, '{"other": 1}');
    `);
  });

  it('takes .com faces with no stored verdict, skipping deleted models and missing covers', async () => {
    const { candidates, dangling, faces } = await readCandidates(10, true);
    expect({ candidates, dangling, ids: faces.map((f) => f.id) }).toEqual({
      candidates: 2,
      dangling: 1,
      ids: [1, 7],
    });
    expect(faces[0].lockedProperties).toEqual([]);
  });

  it('caps the batch at --limit', async () => {
    expect((await readCandidates(1, true)).faces.map((f) => f.id)).toEqual([1]);
    expect((await readCandidates(1, false)).faces).toHaveLength(1);
  });
});
