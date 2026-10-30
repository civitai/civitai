import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** The storyline around a reported post, as the post report queue shows it, on the real SQL. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));

const { getPostStorylineChapter } = await import('../storyline-takedown.service');

const SCHEMA = `
CREATE TABLE "Storyline" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByScan" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByModerator" BOOLEAN NOT NULL DEFAULT false,
  "minorByScan" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "StorylineChapter" (
  "id" INTEGER PRIMARY KEY,
  "storylineId" INTEGER NOT NULL,
  "postId" INTEGER UNIQUE,
  "depth" INTEGER NOT NULL,
  "removedAt" TIMESTAMP
);
INSERT INTO "Storyline" ("id", "title", "minorByScan") VALUES (1, 'First story', false), (2, 'Second story', true);
INSERT INTO "StorylineChapter" VALUES
  (11, 1, 500, 0, NULL),
  (12, 2, 600, 0, NULL),
  (13, 2, 601, 2, now());
`;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('the storyline around a reported post', () => {
  it('names the storyline and the chapter number a reader sees', async () => {
    expect(await getPostStorylineChapter(601)).toEqual({
      storylineId: 2,
      title: 'Second story',
      number: 3,
      removed: true,
      tosViolation: false,
      minorByScan: true,
    });
    expect(await getPostStorylineChapter(500)).toMatchObject({
      storylineId: 1,
      number: 1,
      removed: false,
      minorByScan: false,
    });
  });

  it('is null for a post that is no chapter', async () => {
    expect(await getPostStorylineChapter(999)).toBeNull();
  });
});
