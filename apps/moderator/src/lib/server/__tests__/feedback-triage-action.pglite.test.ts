import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOD_ACTION } from '@civitai/moderation';
import {
  countRows,
  feedbackKysely,
  freshAppFeedbackDb,
  readFeedback,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * The `feedback-triage` mod-action: the main app's API door to the queue's own triage write.
 *
 * Driven through the REGISTRY, so each case runs the wire schema the main app's client is held to
 * and then `triageFeedback` itself against real rows. There is no second implementation to test:
 * what a moderator's status button does is what this does, plus the two things only this door asks
 * for (append to the note, record the HQ task).
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
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

const { modActions } = await import('../mod-actions/registry');
const action = modActions[MOD_ACTION.feedbackTriage];

const NOW = '2026-10-20T08:30:00.000Z';
/**
 * What `seedFeedback` stamps as `handledAt` when given a handler, distinct from NOW. Compared as the
 * column's TEXT: PGlite reads a `timestamp without time zone` back shifted by the local offset (the
 * harness header), so a `Date` comparison would depend on the runner's time zone.
 */
const SEEDED_HANDLED_AT = '2026-09-02 09:00:00';
const HQ_URL = 'https://hq.civitai.com/t/abc_def_9xyz';
const LISTING_ID = 'al_triage_action';

let db: PGlite;
let moderatorId: number;
let otherModeratorId: number;
let reporterId: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = await freshAppFeedbackDb();
  dbHandle.current = feedbackKysely(db);
  moderatorId = await seedUser(db, 'quinn');
  otherModeratorId = await seedUser(db, 'rowan');
  reporterId = await seedUser(db, 'reporter');
});

afterEach(async () => {
  vi.useRealTimers();
  dbHandle.current = null;
  await db.close();
});

/** Through the registry entry exactly as `/api/mod/[action]` runs it: parse, then handle. */
async function run(input: Record<string, unknown>) {
  const parsed = action.schema.safeParse({ userId: moderatorId, ...input });
  if (!parsed.success) throw new Error(`schema refused: ${parsed.error.message}`);
  return action.handler(parsed.data);
}

async function readContext(id: number) {
  const res = await db.query<{ context: Record<string, unknown> }>(
    'SELECT "context" FROM "Feedback" WHERE "id" = $1',
    [id]
  );
  return res.rows[0].context;
}

async function handledAtText(id: number) {
  const res = await db.query<{ at: string | null }>(
    'SELECT "handledAt"::text AS "at" FROM "Feedback" WHERE "id" = $1',
    [id]
  );
  return res.rows[0].at;
}

describe('feedback-triage: the status write', () => {
  it('moves a new row and stamps the acting moderator and the time', async () => {
    const id = await seedFeedback(db, { userId: reporterId });

    expect(await run({ id, status: 'reviewed', expectedStatus: 'new' })).toEqual({
      ok: true,
      changed: true,
    });

    const row = await readFeedback(db, id);
    expect(row.status).toBe('reviewed');
    expect(row.handledById).toBe(moderatorId);
    // Stamped NOW, not left at a seeded value: there was none.
    expect(await handledAtText(id)).toBe('2026-10-20 08:30:00');
    // One audit row, naming this moderator.
    const audit = await db.query<{ userId: number; entityId: number; activity: string }>(
      'SELECT "userId", "entityId", "activity" FROM "ModActivity"'
    );
    expect(audit.rows).toEqual([{ userId: moderatorId, entityId: id, activity: 'triage' }]);
  });

  it('refuses a row that moved since the caller read it, and changes nothing on it', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      status: 'dismissed',
      handledById: otherModeratorId,
      triageNote: 'kept',
      context: { path: '/x' },
    });

    expect(
      await run({
        id,
        status: 'actioned',
        expectedStatus: 'new',
        noteAppend: 'should not land',
        hqTaskUrl: HQ_URL,
      })
    ).toEqual({ ok: true, changed: false });

    const row = await readFeedback(db, id);
    expect(row).toMatchObject({
      status: 'dismissed',
      handledById: otherModeratorId,
      triageNote: 'kept',
    });
    expect(await handledAtText(id)).toBe(SEEDED_HANDLED_AT);
    expect(await readContext(id)).toEqual({ path: '/x' });
    expect(await countRows(db, 'ModActivity')).toBe(0);
  });

  it('answers gone for a row that does not exist', async () => {
    expect(await run({ id: 990000101, status: 'reviewed', expectedStatus: 'new' })).toEqual({
      ok: false,
      reason: 'gone',
    });
  });

  it('clears the handler when the row goes back to new, as the queue does', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      status: 'reviewed',
      handledById: otherModeratorId,
    });
    await run({ id, status: 'new', expectedStatus: 'reviewed' });
    expect(await readFeedback(db, id)).toMatchObject({
      status: 'new',
      handledById: null,
      handledAt: null,
    });
  });
});

describe('feedback-triage: the handler guard', () => {
  it('refuses a write scoped on a handler the row no longer has, and changes nothing', async () => {
    // The sync read the row as its own (moderatorId); a moderator re-stamped it since.
    const id = await seedFeedback(db, {
      userId: reporterId,
      status: 'reviewed',
      handledById: otherModeratorId,
    });
    expect(
      await run({
        id,
        status: 'dismissed',
        expectedStatus: 'reviewed',
        expectedHandledById: moderatorId,
      })
    ).toEqual({ ok: true, changed: false });
    expect(await readFeedback(db, id)).toMatchObject({
      status: 'reviewed',
      handledById: otherModeratorId,
    });
    expect(await handledAtText(id)).toBe(SEEDED_HANDLED_AT);
  });

  it('writes when the handler is still the one read', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      status: 'reviewed',
      handledById: moderatorId,
    });
    expect(
      await run({
        id,
        status: 'dismissed',
        expectedStatus: 'reviewed',
        expectedHandledById: moderatorId,
      })
    ).toEqual({ ok: true, changed: true });
    expect((await readFeedback(db, id)).status).toBe('dismissed');
  });

  it('reads a null expected handler as "nobody", matching only an unhandled row', async () => {
    const unhandled = await seedFeedback(db, { userId: reporterId });
    const handled = await seedFeedback(db, {
      userId: reporterId,
      status: 'new',
      handledById: otherModeratorId,
    });
    const args = { status: 'reviewed', expectedStatus: 'new', expectedHandledById: null };
    expect(await run({ id: unhandled, ...args })).toEqual({ ok: true, changed: true });
    expect(await run({ id: handled, ...args })).toEqual({ ok: true, changed: false });
  });
});

describe('feedback-triage: the note', () => {
  it('appends below a stored note, keeping it', async () => {
    const id = await seedFeedback(db, { userId: reporterId, triageNote: 'first line' });
    await run({ id, status: 'reviewed', expectedStatus: 'new', noteAppend: 'second line' });
    expect((await readFeedback(db, id)).triageNote).toBe('first line\n\nsecond line');
  });

  it('starts the note when there is none', async () => {
    const id = await seedFeedback(db, { userId: reporterId, triageNote: null });
    await run({ id, status: 'reviewed', expectedStatus: 'new', noteAppend: 'only line' });
    expect((await readFeedback(db, id)).triageNote).toBe('only line');
  });

  it('treats an empty stored note as none', async () => {
    const id = await seedFeedback(db, { userId: reporterId, triageNote: '' });
    await run({ id, status: 'reviewed', expectedStatus: 'new', noteAppend: 'only line' });
    expect((await readFeedback(db, id)).triageNote).toBe('only line');
  });

  it('leaves the stored note alone when nothing is appended', async () => {
    const id = await seedFeedback(db, { userId: reporterId, triageNote: 'untouched' });
    await run({ id, status: 'reviewed', expectedStatus: 'new' });
    expect((await readFeedback(db, id)).triageNote).toBe('untouched');
  });
});

describe('feedback-triage: the HQ task link', () => {
  it('records context.hq beside the keys already there', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      context: { path: '/models/1', sessionId: 's-1' },
    });
    await run({ id, status: 'reviewed', expectedStatus: 'new', hqTaskUrl: HQ_URL });
    expect(await readContext(id)).toEqual({
      path: '/models/1',
      sessionId: 's-1',
      hq: { id: 'abc_def_9xyz', url: HQ_URL },
    });
  });

  it('keeps an apps-platform row’s server state and stamps its change time', async () => {
    const server = { fingerprint: 'f'.repeat(64), reporters: 3, reports: 4 };
    const id = await seedFeedback(db, {
      userId: reporterId,
      area: 'apps-platform',
      context: { server },
    });
    await run({ id, status: 'actioned', expectedStatus: 'new', hqTaskUrl: HQ_URL });
    expect(await readContext(id)).toEqual({
      server: { ...server, changedAt: NOW },
      hq: { id: 'abc_def_9xyz', url: HQ_URL },
    });
  });

  it('writes the link and the note WITHOUT re-stamping the verdict when the status is unchanged', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      status: 'reviewed',
      handledById: otherModeratorId,
    });
    expect(
      await run({
        id,
        status: 'reviewed',
        expectedStatus: 'reviewed',
        noteAppend: 'linked',
        hqTaskUrl: HQ_URL,
      })
    ).toEqual({ ok: true, changed: true });

    const row = await readFeedback(db, id);
    // Who decided, and when, is still the other moderator's verdict.
    expect(row.handledById).toBe(otherModeratorId);
    expect(await handledAtText(id)).toBe(SEEDED_HANDLED_AT);
    expect(row.triageNote).toBe('linked');
    expect((await readContext(id)).hq).toEqual({ id: 'abc_def_9xyz', url: HQ_URL });
  });
});

describe('feedback-triage: what it never touches', () => {
  it('leaves an app-block row’s owner status alone', async () => {
    const ownerId = await seedUser(db, 'owner');
    await db.query('INSERT INTO "app_listings" ("id") VALUES ($1)', [LISTING_ID]);
    const res = await db.query<{ id: number }>(
      `INSERT INTO "Feedback" ("area", "userId", "message", "context", "appListingId",
         "ownerStatus", "ownerStatusAt", "ownerStatusById")
       VALUES ('app-block', $1, 'msg', '{}'::jsonb, $2, 'resolved', '2026-09-03T00:00:00.000Z', $3)
       RETURNING "id"`,
      [reporterId, LISTING_ID, ownerId]
    );
    const id = res.rows[0].id;

    await run({
      id,
      status: 'dismissed',
      expectedStatus: 'new',
      noteAppend: 'n',
      hqTaskUrl: HQ_URL,
    });

    const owner = await db.query<{ ownerStatus: string; ownerStatusById: number }>(
      'SELECT "ownerStatus", "ownerStatusById" FROM "Feedback" WHERE "id" = $1',
      [id]
    );
    expect(owner.rows[0]).toEqual({ ownerStatus: 'resolved', ownerStatusById: ownerId });
    expect((await readFeedback(db, id)).status).toBe('dismissed');
  });
});

describe('feedback-triage: the wire schema', () => {
  const base = { id: 1, status: 'reviewed', expectedStatus: 'new', userId: 2 };

  it.each([
    ['a status outside the CHECK', { status: 'closed' }],
    ['an expected status outside the CHECK', { expectedStatus: 'triaged' }],
    ['a link to another host', { hqTaskUrl: 'https://example.com/t/abc' }],
    ['a link with a query', { hqTaskUrl: `${HQ_URL}?x=1` }],
    ['a blank note', { noteAppend: '   ' }],
    ['a note over the cap', { noteAppend: 'x'.repeat(2001) }],
    ['a non-positive id', { id: 0 }],
  ])('refuses %s', (_label, over) => {
    expect(action.schema.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it('accepts a note at the cap', () => {
    expect(action.schema.safeParse({ ...base, noteAppend: 'x'.repeat(2000) }).success).toBe(true);
  });
});
