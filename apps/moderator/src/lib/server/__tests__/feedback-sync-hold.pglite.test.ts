import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_SYNC_HOLD_KEY } from '@civitai/shared/feedback.constants';
import {
  feedbackKysely,
  freshFeedbackDb,
  seedBug,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * The HQ sync HOLD (`context.syncHold`), against a real Postgres carrying the real migrations.
 *
 * A moderator moving a row back to `new` clears its handler, so the row looked never triaged and
 * the HQ status sync's next run moved it straight back to `reviewed`. Every triage write that moves
 * the status now moves the hold with it: a move BACK to `new` sets it, a move to any other status
 * removes it. The sync skips a held row (pinned in `feedback-hq-sync.service.test.ts`).
 *
 * Only rows can show this: the hold is a jsonb key written in the same UPDATE as the status, and
 * what matters is the stored `context` afterwards, other keys included.
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

/** A row with an HQ link already recorded, so each case also shows other context keys survive. */
const HQ = { id: '868abc123', url: 'https://hq.civitai.com/t/868abc123' };
const seed = (status: string, handledById: number | null = null) =>
  seedFeedback(db, { userId: reporterId, status, handledById, context: { hq: HQ } });

const context = async (id: number): Promise<Record<string, unknown>> => {
  const res = await db.query<{ context: Record<string, unknown> }>(
    'SELECT "context" FROM "Feedback" WHERE "id" = $1',
    [id]
  );
  return res.rows[0].context;
};

const triage = (id: number, expectedStatus: string, status: string) =>
  service.triageFeedback({
    id,
    expectedStatus: expectedStatus as never,
    status: status as never,
    moderatorId,
  });

describe('the HQ sync hold: single-row triage', () => {
  it('🔴 a move BACK to new sets the hold, naming who and when, and keeps the HQ link', async () => {
    const id = await seed('reviewed', moderatorId);
    await expect(triage(id, 'reviewed', 'new')).resolves.toEqual({ ok: true, changed: true });

    const ctx = await context(id);
    expect(ctx.hq).toEqual(HQ);
    const hold = ctx[FEEDBACK_SYNC_HOLD_KEY] as { at: unknown; by: unknown };
    expect(hold.by).toBe(moderatorId);
    expect(typeof hold.at).toBe('string');
    expect(Number.isNaN(Date.parse(hold.at as string))).toBe(false);
  });

  it.each(['reviewed', 'actioned', 'dismissed'])(
    '🔴 a move forward to %s removes the hold, and keeps the HQ link',
    async (to) => {
      const id = await seed('reviewed', moderatorId);
      await triage(id, 'reviewed', 'new');
      expect(Object.keys(await context(id))).toContain(FEEDBACK_SYNC_HOLD_KEY);

      await expect(triage(id, 'new', to)).resolves.toEqual({ ok: true, changed: true });
      expect(await context(id)).toEqual({ hq: HQ });
    }
  );

  it('a row never moved back to new never gets a hold (a first triage, a note on a new row)', async () => {
    const fresh = await seed('new');
    await service.triageFeedback({
      id: fresh,
      expectedStatus: 'new',
      status: 'new',
      note: 'looking',
      moderatorId,
    });
    expect(await context(fresh)).toEqual({ hq: HQ });

    await triage(fresh, 'new', 'reviewed');
    expect(await context(fresh)).toEqual({ hq: HQ });
  });

  it('a refused write (stale expectation) sets nothing', async () => {
    const id = await seed('reviewed', moderatorId);
    await expect(triage(id, 'actioned', 'new')).resolves.toEqual({ ok: true, changed: false });
    expect(await context(id)).toEqual({ hq: HQ });
  });
});

describe('the HQ sync hold: bulk triage', () => {
  it('🔴 a bulk move back to new holds every row it moved, and a bulk move forward releases them', async () => {
    const a = await seed('reviewed', moderatorId);
    const b = await seed('actioned', moderatorId);
    await service.bulkTriageFeedback({
      rows: [
        { id: a, expectedStatus: 'reviewed' },
        { id: b, expectedStatus: 'actioned' },
      ],
      status: 'new',
      moderatorId,
    });
    for (const id of [a, b])
      expect(Object.keys(await context(id))).toContain(FEEDBACK_SYNC_HOLD_KEY);

    await service.bulkTriageFeedback({
      rows: [
        { id: a, expectedStatus: 'new' },
        { id: b, expectedStatus: 'new' },
      ],
      status: 'dismissed',
      moderatorId,
    });
    for (const id of [a, b]) expect(await context(id)).toEqual({ hq: HQ });
  });
});

describe('the HQ sync hold: linking to an issue', () => {
  it('linking a held row to an issue (which actions it) removes the hold', async () => {
    const id = await seed('reviewed', moderatorId);
    await triage(id, 'reviewed', 'new');
    const bugId = await seedBug(db, 'the list is empty');

    await expect(service.linkFeedbackToBug({ id, bugId, moderatorId })).resolves.toMatchObject({
      ok: true,
    });
    expect(await context(id)).toEqual({ hq: HQ });
  });
});
