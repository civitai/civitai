import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  feedbackKysely,
  freshFeedbackDb,
  readFeedback,
  seedBug,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * `bulkTriageFeedback`, executed against a real Postgres carrying the real migrations.
 *
 * 🔴 THIS TIER IS THE ONLY ONE THAT CAN ANSWER THE QUESTION THIS FUNCTION EXISTS TO GET RIGHT:
 * WHICH ROWS MOVED. The per-row `expectedStatus` guard is a statement about the scope of an UPDATE,
 * and a mocked builder can only be asked what it was told — it has no rows, so it cannot tell an
 * UPDATE correctly scoped to two ids at one status from one that moved the whole table. The action
 * suite next door pins the TRANSLATION of this function's result; only rows pin the result.
 *
 * The defect being hunted is specific and silent: a bulk action that dropped the per-row half of the
 * guard would overwrite a colleague's verdict on every selected row and report complete success,
 * which on screen is indistinguishable from the correct outcome.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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

const service = await import('../feedback.service');

let db: PGlite;
let moderatorId: number;
let reporterId: number;

beforeEach(async () => {
  db = await freshFeedbackDb();
  dbHandle.current = feedbackKysely(db);
  moderatorId = await seedUser(db, 'quinn');
  reporterId = await seedUser(db, 'reporter');
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const seed = (status: string, over: { bugId?: number } = {}) =>
  seedFeedback(db, { ...over, userId: reporterId, status });

const activityIds = async (): Promise<number[]> => {
  const res = await db.query<{ entityId: number }>(
    `SELECT "entityId" FROM "ModActivity" WHERE "entityType" = 'feedback' ORDER BY "entityId"`
  );
  return res.rows.map((r) => r.entityId);
};

describe('bulkTriageFeedback', () => {
  /**
   * 🔴 THE CENTRAL CLAIM, AND IT NEEDS THE NEIGHBOUR TO BE MEANINGFUL. One row's status is moved
   * out from under the operator between the page load and the click; the OTHER two, whose posted
   * expectation still matches, must go through. A guard that refused the whole batch would pass an
   * assertion about the stale row alone, and so would one that had no guard at all if the only
   * assertion were "the fresh rows moved". Both halves, in one case.
   */
  it('moves the rows whose expectation still holds and leaves the stale one alone', async () => {
    const fresh1 = await seed('new');
    const stale = await seed('new');
    const fresh2 = await seed('new');

    // A colleague triages `stale` after the operator's page was rendered.
    await db.query('UPDATE "Feedback" SET "status" = $1 WHERE "id" = $2', ['dismissed', stale]);

    const result = await service.bulkTriageFeedback({
      rows: [fresh1, stale, fresh2].map((id) => ({ id, expectedStatus: 'new' as const })),
      status: 'reviewed',
      moderatorId,
    });

    expect(result.changed.sort()).toEqual([fresh1, fresh2].sort());
    expect(result.actionable).toBe(3);
    expect((await readFeedback(db, stale)).status).toBe('dismissed');
    expect((await readFeedback(db, fresh1)).status).toBe('reviewed');
    expect((await readFeedback(db, fresh2)).status).toBe('reviewed');
  });

  /**
   * A selection spans rows at different statuses — that is the ordinary case, not an edge one — and
   * the function issues one statement per distinct expectation. A version that took a single
   * expectation from the first row would move that group and silently skip the rest.
   */
  it('moves rows sitting at different statuses in one call', async () => {
    const a = await seed('new');
    const b = await seed('reviewed');
    const c = await seed('dismissed');

    const result = await service.bulkTriageFeedback({
      rows: [
        { id: a, expectedStatus: 'new' },
        { id: b, expectedStatus: 'reviewed' },
        { id: c, expectedStatus: 'dismissed' },
      ],
      status: 'actioned',
      moderatorId,
    });

    expect(result.changed.sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) expect((await readFeedback(db, id)).status).toBe('actioned');
  });

  /**
   * 🔴 EXCLUDED FROM `actionable`, NOT COUNTED AS A CONFLICT. Its UPDATE cannot match — the guard
   * and the assignment name the same status — so leaving it in the denominator would report it to
   * the operator as "already triaged by someone else", a conflict that did not happen over a row
   * that is in exactly the state they asked for.
   */
  it('skips a row already at the target status without calling it a conflict', async () => {
    const already = await seed('reviewed');
    const moving = await seed('new');

    const result = await service.bulkTriageFeedback({
      rows: [
        { id: already, expectedStatus: 'reviewed' },
        { id: moving, expectedStatus: 'new' },
      ],
      status: 'reviewed',
      moderatorId,
    });

    expect(result.changed).toEqual([moving]);
    expect(result.actionable).toBe(1);
  });

  it('reports nothing actionable when every selected row is already there', async () => {
    const a = await seed('dismissed');

    const result = await service.bulkTriageFeedback({
      rows: [{ id: a, expectedStatus: 'dismissed' }],
      status: 'dismissed',
      moderatorId,
    });

    expect(result).toEqual({ changed: [], actionable: 0 });
  });

  it('stamps the handler on a triage and CLEARS it on a reopen', async () => {
    const id = await seed('new');

    await service.bulkTriageFeedback({
      rows: [{ id, expectedStatus: 'new' }],
      status: 'actioned',
      moderatorId,
    });
    const handled = await readFeedback(db, id);
    expect(handled.handledById).toBe(moderatorId);
    expect(handled.handledAt).not.toBeNull();

    // 🔴 Back to `new` must clear both: "handled by" naming a moderator on a row sitting in the
    // unhandled queue is a claim the screen cannot support.
    await service.bulkTriageFeedback({
      rows: [{ id, expectedStatus: 'actioned' }],
      status: 'new',
      moderatorId,
    });
    const reopened = await readFeedback(db, id);
    expect(reopened.handledById).toBeNull();
    expect(reopened.handledAt).toBeNull();
  });

  /**
   * 🔴 `bugId` SURVIVES A BULK STATUS CHANGE, exactly as it does on the single-row path. The link
   * records THAT THIS REPORT IS ABOUT THAT ISSUE, which a status change does not make false, and
   * nothing in this app can restore it once cleared (`linkInTransaction` requires `bugId IS NULL`).
   */
  it('leaves the issue link alone, reopen included', async () => {
    const bugId = await seedBug(db, 'uploads fail on safari');
    const id = await seed('actioned', { bugId });

    await service.bulkTriageFeedback({
      rows: [{ id, expectedStatus: 'actioned' }],
      status: 'new',
      moderatorId,
    });

    expect((await readFeedback(db, id)).bugId).toBe(bugId);
  });

  /**
   * 🔴 A BULK VERDICT NEVER TOUCHES `triageNote`, AND THIS IS THE GUARD ON THAT.
   *
   * A note says something about ONE report, so a batch verdict must leave every row's note exactly
   * as it found it. 🔴 Adding a note box to the bar reintroduces two hazards at once: it overwrites
   * whatever each selected row already had, and being a TEXT FIELD in a form whose first submit
   * button is Reopen, it makes Enter reopen the entire selection.
   */
  it('never writes a note, on any row it moves', async () => {
    const withNote = await seed('new');
    const withoutNote = await seed('new');
    await db.query('UPDATE "Feedback" SET "triageNote" = $1 WHERE "id" = $2', ['keep me', withNote]);

    await service.bulkTriageFeedback({
      rows: [withNote, withoutNote].map((id) => ({ id, expectedStatus: 'new' as const })),
      status: 'reviewed',
      moderatorId,
    });

    expect((await readFeedback(db, withNote)).triageNote).toBe('keep me');
    expect((await readFeedback(db, withoutNote)).triageNote).toBeNull();
  });

  /**
   * 🔴 THE AUDIT LOG NAMES THE ROWS THAT ACTUALLY MOVED, AND NOTHING ELSE. `ModActivity` is
   * append-only, so a row logged for a report this moderator did not move is a permanent claim that
   * they triaged something they did not — the reason the function returns ids rather than a count.
   */
  it('records one activity row per CHANGED report, and none for the refused', async () => {
    const moved = await seed('new');
    const stale = await seed('new');
    await db.query('UPDATE "Feedback" SET "status" = $1 WHERE "id" = $2', ['dismissed', stale]);

    await service.bulkTriageFeedback({
      rows: [moved, stale].map((id) => ({ id, expectedStatus: 'new' as const })),
      status: 'reviewed',
      moderatorId,
    });

    expect(await activityIds()).toEqual([moved]);
  });

  it('writes no activity rows when nothing moved', async () => {
    const stale = await seed('new');
    await db.query('UPDATE "Feedback" SET "status" = $1 WHERE "id" = $2', ['dismissed', stale]);

    await service.bulkTriageFeedback({
      rows: [{ id: stale, expectedStatus: 'new' }],
      status: 'reviewed',
      moderatorId,
    });

    expect(await activityIds()).toEqual([]);
  });

  /**
   * An id the operator cannot have selected — a deleted row, or an edited payload. It must simply
   * not match, without taking its batch with it.
   */
  it('ignores an id that no longer exists without failing its neighbours', async () => {
    const live = await seed('new');

    const result = await service.bulkTriageFeedback({
      rows: [
        { id: live, expectedStatus: 'new' },
        { id: live + 99_999, expectedStatus: 'new' },
      ],
      status: 'reviewed',
      moderatorId,
    });

    expect(result.changed).toEqual([live]);
    expect(result.actionable).toBe(2);
  });
});

describe('getKnownIssues', () => {
  it('offers non-disabled issues, newest first, and hides disabled ones', async () => {
    const first = await seedBug(db, 'uploads fail on safari');
    const second = await seedBug(db, 'feed is empty for new accounts');
    const retired = await seedBug(db, 'retired');
    await db.query('UPDATE "Bug" SET "disabled" = true WHERE "id" = $1', [retired]);

    const issues = await service.getKnownIssues();

    expect(issues.map((i) => i.id)).toEqual([second, first]);
    expect(issues[0]).toMatchObject({
      title: 'feed is empty for new accounts',
      status: 'Open',
      closed: false,
    });
  });

  /**
   * 🔴 `closed` IS RESOLVED BY THE SERVICE, NOT BY THE PICKER READING THE STRING. `Bug.status` is a
   * free-form ClickUp value with no enum, so "Complete" and "Done" both mean closed — a caller
   * comparing against a literal would call them open. `isBugClosed` is the one definition, and this
   * is what stops the picker growing a second one.
   */
  it('marks an issue closed by the app definition, not by a literal match', async () => {
    const open = await seedBug(db, 'still broken');
    const done = await seedBug(db, 'fixed last week');
    // Not 'closed' — a status that only the real predicate recognises.
    await db.query('UPDATE "Bug" SET "status" = $1 WHERE "id" = $2', ['Complete', done]);

    const byId = new Map((await service.getKnownIssues()).map((i) => [i.id, i]));

    expect(byId.get(done)).toMatchObject({ status: 'Complete', closed: true });
    expect(byId.get(open)).toMatchObject({ closed: false });
  });

  it('bounds what it returns', async () => {
    for (let i = 0; i < 5; i++) await seedBug(db, `issue ${i}`);

    expect(await service.getKnownIssues(3)).toHaveLength(3);
  });
});
