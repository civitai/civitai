import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, callModEndpoint } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  callModEndpoint: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// The real module imports `$app/server`, which only exists inside SvelteKit.
vi.mock('../user-actions.service', () => ({ callModEndpoint }));

const { getStorylineTitleAppeals, resolveStorylineTitleAppeal } = await import(
  '../storyline-title-appeal.service'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Bounty', 'Storyline');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Storyline" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "tosViolationByScan" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByModerator" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL,
  "appealMessage" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL,
  "entityRemovedAt" TIMESTAMP
);
INSERT INTO "User" VALUES (3, 'owner');
INSERT INTO "Storyline" VALUES (10, 3, 'Down by the scan', true, false), (11, 3, 'Already ruled on', true, false), (12, 3, 'Removed', true, false);
INSERT INTO "Appeal" ("entityType", "entityId", "status", "appealMessage", "createdAt", "entityRemovedAt") VALUES
  ('Storyline', 10, 'Pending', 'newer', '2026-10-02', NULL),
  ('Storyline', 10, 'Pending', 'older', '2026-10-01', NULL),
  ('Storyline', 11, 'Rejected', 'ruled', '2026-10-01', NULL),
  ('Storyline', 12, 'Pending', 'gone', '2026-10-01', '2026-10-03'),
  ('Bounty', 10, 'Pending', 'bounty', '2026-09-01', NULL);
`;

let pg: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('storyline title appeals queue', () => {
  it("lists open storyline appeals, oldest first, with the storyline's title and takedown", async () => {
    const { items, hasMore } = await getStorylineTitleAppeals({ limit: 10 });
    expect(items.map((i) => i.appealMessage)).toEqual(['older', 'newer']);
    expect(items[0]).toMatchObject({
      storylineId: 10,
      title: 'Down by the scan',
      userId: 3,
      username: 'owner',
      tosViolationByScan: true,
      tosViolationByModerator: false,
    });
    expect(hasMore).toBe(false);
    expect((await getStorylineTitleAppeals({ limit: 1 })).hasMore).toBe(true);
  });

  it('sends the ruling with the title the moderator was shown', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: {} });
    await expect(resolveStorylineTitleAppeal(10, true, 'Down by the scan')).resolves.toEqual({
      ok: true,
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'storyline/resolve-title-appeal',
      { storylineId: 10, grant: true, reviewedTitle: 'Down by the scan' },
      'Grant appeal'
    );
    callModEndpoint.mockResolvedValue({ ok: false, error: 'Grant appeal: title changed' });
    await expect(resolveStorylineTitleAppeal(10, true, 'x')).resolves.toEqual({
      ok: false,
      error: 'Grant appeal: title changed',
    });
  });
});
