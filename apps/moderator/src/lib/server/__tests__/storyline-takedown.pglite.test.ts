import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A moderator's storyline takedown and restore from the report queue, on the real SQL. The title
 * scan lifts only a takedown marked as its own (`tosViolationByScan`), so the property is that a
 * moderator's takedown is never marked that way and a restore never clears the scan's.
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

const UP = 10;
const SCAN_DOWN = 11;
const MOD = 7;

const SCHEMA = `
CREATE TABLE "Storyline" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  "tosViolationByScan" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "StorylineReport" ("reportId" INTEGER NOT NULL, "storylineId" INTEGER NOT NULL);
INSERT INTO "Storyline" VALUES (${UP}, 'Up', false, false), (${SCAN_DOWN}, 'Scanned', true, true);
INSERT INTO "StorylineReport" VALUES (100, ${UP});
`;

/** The title scan's lift, as `applyStorylineTextScan` writes it on a clean verdict. */
const cleanScanLift = (id: number) =>
  pg.query(
    `UPDATE "Storyline" SET "tosViolation" = false, "tosViolationByScan" = false WHERE id = $1 AND "tosViolationByScan" = true`,
    [id]
  );
const state = async (id: number) =>
  (
    await pg.query<{ tosViolation: boolean; tosViolationByScan: boolean }>(
      `SELECT "tosViolation", "tosViolationByScan" FROM "Storyline" WHERE id = $1`,
      [id]
    )
  ).rows[0];

let pg: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('storyline takedown from the report queue', () => {
  it('finds the storyline a report is about', async () => {
    expect(await getReportStorylineId(100)).toBe(UP);
    expect(await getReportStorylineId(999)).toBeNull();
  });

  // The control: the scan's lift does lift its own takedown on this table.
  it("a clean scan lifts the scan's own takedown", async () => {
    await cleanScanLift(SCAN_DOWN);
    expect(await state(SCAN_DOWN)).toEqual({ tosViolation: false, tosViolationByScan: false });
  });

  it("a clean scan does not lift a moderator's takedown, including one over the scan's", async () => {
    for (const id of [UP, SCAN_DOWN]) {
      await setStorylineTakedown({ storylineId: id, takenDown: true, moderatorId: MOD });
      await cleanScanLift(id);
      expect(await state(id)).toEqual({ tosViolation: true, tosViolationByScan: false });
    }
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: MOD,
      entityType: 'storyline',
      entityId: UP,
      activity: 'takedown',
    });
  });

  it("restores a moderator's takedown", async () => {
    await setStorylineTakedown({ storylineId: UP, takenDown: true, moderatorId: MOD });
    await expect(
      setStorylineTakedown({ storylineId: UP, takenDown: false, moderatorId: MOD })
    ).resolves.toMatchObject({ tosViolation: false });
    expect(recordModActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ activity: 'restore' })
    );
  });

  it("leaves the scan's takedown in place on a restore, and records nothing", async () => {
    await expect(
      setStorylineTakedown({ storylineId: SCAN_DOWN, takenDown: false, moderatorId: MOD })
    ).resolves.toMatchObject({ tosViolation: true, tosViolationByScan: true });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('is null for a storyline that no longer exists', async () => {
    expect(
      await setStorylineTakedown({ storylineId: 999, takenDown: true, moderatorId: MOD })
    ).toBeNull();
  });
});
