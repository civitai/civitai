import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelNotWithheldSql } from '~/server/utils/model-withheld';

// A taken-down model is its owner's and moderators' alone; every other model passes.
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE m (id int PRIMARY KEY, mode "ModelModifier", "userId" int);
    INSERT INTO m VALUES (1, NULL, 10), (2, 'Archived', 10), (3, 'TakenDown', 10), (4, 'TakenDown', -1);
  `);
});
afterAll(() => pg.close());

const visible = async (viewer: {
  signedIn: boolean;
  viewerId: number | null;
  isModerator: boolean;
}) => {
  const where = modelNotWithheldSql({
    mode: Prisma.raw('m.mode'),
    ownerId: Prisma.raw('m."userId"'),
    ...viewer,
  });
  const q = Prisma.sql`SELECT id FROM m WHERE ${where} ORDER BY id`;
  const { rows } = await pg.query<{ id: number }>(q.text, q.values as unknown[]);
  return rows.map((r) => r.id);
};

describe('modelNotWithheldSql', () => {
  it('hides a taken-down model from a visitor and a signed-out viewer', async () => {
    expect(await visible({ signedIn: true, viewerId: 20, isModerator: false })).toEqual([1, 2]);
    expect(await visible({ signedIn: false, viewerId: null, isModerator: false })).toEqual([1, 2]);
  });

  it("shows it to its owner, and only the owner's", async () => {
    expect(await visible({ signedIn: true, viewerId: 10, isModerator: false })).toEqual([1, 2, 3]);
  });

  it('shows every model to a moderator', async () => {
    expect(await visible({ signedIn: true, viewerId: 30, isModerator: true })).toEqual([
      1, 2, 3, 4,
    ]);
  });

  // A placeholder id must never make a signed-out viewer the owner of a system account's model.
  it('does not treat a signed-out viewer as the owner, whatever id it carries', async () => {
    expect(await visible({ signedIn: false, viewerId: -1, isModerator: false })).toEqual([1, 2]);
  });
});
