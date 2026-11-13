import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A moderator's storyline takedown and restore from the report queue, on the real SQL, run
 * against the title scan's own writes. The two hold separate flags and the storyline is down while
 * either does, so the properties are about sequences: a restore never publishes a title the scan
 * flagged, and a clean rescan never lifts a moderator's takedown.
 */

const { dbHandle, recordModActivity } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  recordModActivity: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../mod-activity', () => ({ recordModActivity }));

const { setStorylineTakedown, getReportStorylineId } = await import(
  '../storyline-takedown.service'
);

const ID = 10;
const MOD = 7;

const SCHEMA = `
CREATE TABLE "Storyline" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByScan" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByModerator" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "StorylineReport" ("reportId" INTEGER NOT NULL, "storylineId" INTEGER NOT NULL);
INSERT INTO "Storyline" ("id", "title") VALUES (${ID}, 'A story');
INSERT INTO "StorylineReport" VALUES (100, ${ID});
`;

// The title scan's writes, as `applyStorylineTextScan` makes them in the main app.
const flaggingScan = () =>
  pg.query(
    `UPDATE "Storyline" SET "tosViolation" = true, "tosViolationByScan" = true WHERE id = $1 AND "tosViolationByScan" = false`,
    [ID]
  );
const cleanScan = async () => {
  await pg.query(
    `UPDATE "Storyline" SET "tosViolation" = false, "tosViolationByScan" = false WHERE id = $1 AND "tosViolationByScan" AND NOT "tosViolationByModerator"`,
    [ID]
  );
  await pg.query(
    `UPDATE "Storyline" SET "tosViolationByScan" = false WHERE id = $1 AND "tosViolationByScan" AND "tosViolationByModerator"`,
    [ID]
  );
};
const takeDown = () => setStorylineTakedown({ storylineId: ID, takenDown: true, moderatorId: MOD });
const restore = () => setStorylineTakedown({ storylineId: ID, takenDown: false, moderatorId: MOD });

const state = async () => {
  const { rows } = await pg.query<{
    tosViolation: boolean;
    tosViolationByScan: boolean;
    tosViolationByModerator: boolean;
  }>(
    `SELECT "tosViolation", "tosViolationByScan", "tosViolationByModerator" FROM "Storyline" WHERE id = $1`,
    [ID]
  );
  const r = rows[0];
  return {
    down: r.tosViolation,
    byScan: r.tosViolationByScan,
    byModerator: r.tosViolationByModerator,
  };
};
const UP = { down: false, byScan: false, byModerator: false };

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

describe('storyline takedown from the report queue', () => {
  it('finds the storyline a report is about', async () => {
    expect(await getReportStorylineId(100)).toBe(ID);
    expect(await getReportStorylineId(999)).toBeNull();
  });

  // The controls: each side lifts its own takedown here.
  it('a clean scan lifts the scan’s takedown, and a restore lifts the moderator’s', async () => {
    await flaggingScan();
    await cleanScan();
    expect(await state()).toEqual(UP);
    await takeDown();
    await restore();
    expect(await state()).toEqual(UP);
  });

  it("a clean scan does not lift a moderator's takedown", async () => {
    await takeDown();
    await cleanScan();
    expect(await state()).toEqual({ down: true, byScan: false, byModerator: true });
  });

  it("scan flags, a moderator takes it down, a restore: still down, on the scan's takedown", async () => {
    await flaggingScan();
    await takeDown();
    await expect(restore()).resolves.toMatchObject({ tosViolation: true, changed: true });
    expect(await state()).toEqual({ down: true, byScan: true, byModerator: false });
  });

  it('a moderator takes it down, the edited title is flagged, a restore: still down', async () => {
    await takeDown();
    await flaggingScan();
    await restore();
    expect(await state()).toEqual({ down: true, byScan: true, byModerator: false });
  });

  it('records activity only when the moderator flag changed', async () => {
    await takeDown();
    await expect(takeDown()).resolves.toMatchObject({ changed: false });
    await restore();
    await expect(restore()).resolves.toMatchObject({ changed: false });
    expect(recordModActivity.mock.calls.map(([call]) => call.activity)).toEqual([
      'takedown',
      'restore',
    ]);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: MOD,
      entityType: 'storyline',
      entityId: ID,
      activity: 'takedown',
    });
  });

  it('is null for a storyline that no longer exists', async () => {
    expect(
      await setStorylineTakedown({ storylineId: 999, takenDown: true, moderatorId: MOD })
    ).toBeNull();
  });
});
