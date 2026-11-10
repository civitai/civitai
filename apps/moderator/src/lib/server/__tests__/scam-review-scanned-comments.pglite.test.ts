import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, getGenerationRestrictions } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  getGenerationRestrictions: vi.fn(),
}));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../user-restriction.service', () => ({ getGenerationRestrictions }));
vi.mock('../user-actions.service', () => ({
  banConfirmed: vi.fn(),
  resolveRestriction: vi.fn(),
  setBanned: vi.fn(),
}));

const { scamReviewLoad } = await import('../scam-review');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "CommentV3" ("id" INTEGER PRIMARY KEY, "content" TEXT NOT NULL);
    INSERT INTO "CommentV3" VALUES
      (3, '<p>first comment</p>'),
      (4, '<p>see <a href="https://scam.test">here</a></p>'),
      (5, '<p>never triggered</p>');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const restriction = (id: number, entityType: string, entityId: number) => ({
  id,
  triggers: [{ entityType, entityId }],
});

describe('the scam review reads the text a comment trigger scanned from CommentV3', () => {
  it('gives each restriction the text of the comment its trigger names, links kept', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [restriction(1, 'CommentV3', 3), restriction(2, 'CommentV3', 4)],
      totalCount: 2,
    });
    const { rows, textFailed } = await scamReviewLoad(new URL('https://mod.test/scam'));
    expect(textFailed).toBe(false);
    expect(rows.map((r) => [r.id, r.scanned])).toEqual([
      [1, [{ heading: 'Comment', text: 'first comment' }]],
      [2, [{ heading: 'Comment', text: expect.stringContaining('[link: https://scam.test]') }]],
    ]);
  });
});
