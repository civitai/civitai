import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countRows,
  feedbackKysely,
  freshFeedbackDb,
  readFeedback,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * `feedback.service.ts`, EXECUTED against a real Postgres carrying the real migrations.
 *
 * Every case here is about WHICH ROWS MOVE. A mocked query builder can be asked what it was told
 * and nothing else, so it cannot distinguish "the UPDATE was scoped on the status the operator was
 * looking at" from "the UPDATE was scoped on the id alone" — and those two differ only when a
 * second moderator is mid-verdict, which is exactly when it matters.
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
let reporter: number;
let moderator: number;

beforeEach(async () => {
  db = await freshFeedbackDb();
  dbHandle.current = feedbackKysely(db);
  reporter = await seedUser(db, 'kaeru');
  moderator = await seedUser(db, 'mod');
});

afterEach(async () => {
  vi.restoreAllMocks();
  dbHandle.current = null;
  await db.close();
});

describe('triageFeedback', () => {
  it('moves the row and stamps who handled it', async () => {
    const id = await seedFeedback(db, { userId: reporter });

    const result = await service.triageFeedback({
      id,
      status: 'dismissed',
      expectedStatus: 'new',
      note: 'retired surface',
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: true, changed: true });
    const row = await readFeedback(db, id);
    expect(row.status).toBe('dismissed');
    expect(row.triageNote).toBe('retired surface');
    expect(row.handledById).toBe(moderator);
    expect(row.handledAt).not.toBeNull();
  });

  /**
   * 🔴 THE CONCURRENCY GUARD. Without `AND "status" = $expectedStatus` this returns
   * `{ changed: true }` and silently replaces a colleague's verdict — with a green screen over it.
   */
  it('changes NOTHING when the row already moved under the operator', async () => {
    const id = await seedFeedback(db, { userId: reporter, status: 'actioned' });

    const result = await service.triageFeedback({
      id,
      status: 'dismissed',
      expectedStatus: 'new',
      note: null,
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: true, changed: false });
    expect((await readFeedback(db, id)).status).toBe('actioned');
  });

  it('separates a row that is GONE from one another moderator moved', async () => {
    const result = await service.triageFeedback({
      id: 9999,
      status: 'reviewed',
      expectedStatus: 'new',
      note: null,
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: false, reason: 'gone' });
  });

  /**
   * 🔴 Moving a row back to `new` CLEARS the handler. Stamping it would leave "handled by
   * <moderator>" on a row sitting in the unhandled queue — a claim the screen cannot support.
   */
  it('clears handledById and handledAt when a row goes back to `new`', async () => {
    const id = await seedFeedback(db, { userId: reporter });
    await service.triageFeedback({
      id,
      status: 'actioned',
      expectedStatus: 'new',
      note: null,
      moderatorId: moderator,
    });

    const result = await service.triageFeedback({
      id,
      status: 'new',
      expectedStatus: 'actioned',
      note: 'reopened',
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: true, changed: true });
    const row = await readFeedback(db, id);
    expect(row.status).toBe('new');
    expect(row.handledById).toBeNull();
    expect(row.handledAt).toBeNull();
  });

  it('touches only the row it names', async () => {
    const id = await seedFeedback(db, { userId: reporter });
    const other = await seedFeedback(db, { userId: reporter });

    await service.triageFeedback({
      id,
      status: 'reviewed',
      expectedStatus: 'new',
      note: null,
      moderatorId: moderator,
    });

    expect((await readFeedback(db, other)).status).toBe('new');
  });

  it('records the mod activity only when a row actually moved', async () => {
    const id = await seedFeedback(db, { userId: reporter, status: 'actioned' });

    await service.triageFeedback({
      id,
      status: 'reviewed',
      expectedStatus: 'new',
      note: null,
      moderatorId: moderator,
    });
    expect(await countRows(db, 'ModActivity')).toBe(0);

    await service.triageFeedback({
      id,
      status: 'reviewed',
      expectedStatus: 'actioned',
      note: null,
      moderatorId: moderator,
    });
    expect(await countRows(db, 'ModActivity')).toBe(1);
  });
});

describe('promoteFeedbackToBug', () => {
  it('inserts a Bug that satisfies every NOT NULL the real table declares, and links it', async () => {
    const id = await seedFeedback(db, { userId: reporter });

    const result = await service.promoteFeedbackToBug({
      id,
      title: 'Sort resets on back',
      summary: 'The store loses ?sort on Back.',
      moderatorId: moderator,
    });

    expect(result).toMatchObject({ ok: true, created: true });
    const bug = await db.query<{
      id: number;
      title: string;
      summary: string;
      status: string;
      publishedAt: Date | null;
      resolvedAt: Date | null;
      content: string | null;
      updatedAt: Date | null;
    }>('SELECT * FROM "Bug"');
    expect(bug.rows).toHaveLength(1);
    expect(bug.rows[0]).toMatchObject({
      title: 'Sort resets on back',
      summary: 'The store loses ?sort on Back.',
      status: 'Open',
      // 🔴 NULL is what keeps the reporter's words off the public Known Issues board — `getBugs`
      // hides an unpublished Bug from anyone without the `bugsEdit` flag.
      publishedAt: null,
      resolvedAt: null,
      // 🔴 NULL deliberately. `content` is stored and rendered as HTML; the feedback message is
      // plain text a user typed, and this app does not go through the sanitising zod schema.
      content: null,
    });
    // `updatedAt` is `@updatedAt` in Prisma — a CLIENT-side stamp. The column is NOT NULL with no
    // database default and this app installs no updatedAt plugin, so omitting it is a 23502.
    expect(bug.rows[0].updatedAt).not.toBeNull();

    const row = await readFeedback(db, id);
    expect(row.bugId).toBe(bug.rows[0].id);
    expect(row.status).toBe('actioned');
    expect(row.handledById).toBe(moderator);
  });

  /**
   * 🔴 `AND "bugId" IS NULL` makes double-promotion impossible — and the Bug insert must roll back
   * WITH it, or a second click leaves an orphan row on the table the public board reads.
   */
  it('refuses a second promotion and leaves no orphan Bug behind', async () => {
    const id = await seedFeedback(db, { userId: reporter });
    await service.promoteFeedbackToBug({ id, title: 'a', summary: 'b', moderatorId: moderator });

    const result = await service.promoteFeedbackToBug({
      id,
      title: 'a second one',
      summary: 'b',
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: false, reason: 'already-linked' });
    expect(await countRows(db, 'Bug')).toBe(1);
  });

  /**
   * The `gone` branch reached from INSIDE the promote transaction. Distinct from
   * `linkFeedbackToBug`'s twin: this one resolves its reason against the open transaction rather
   * than a separate client, and it must roll the Bug insert back with it.
   */
  it('reports a report that vanished mid-promotion as gone, and leaves no Bug behind', async () => {
    const result = await service.promoteFeedbackToBug({
      id: 9999,
      title: 'a',
      summary: 'b',
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: false, reason: 'gone' });
    expect(await countRows(db, 'Bug')).toBe(0);
  });
});

describe('linkFeedbackToBug', () => {
  it('attaches a second report to an issue that already exists', async () => {
    const first = await seedFeedback(db, { userId: reporter });
    const second = await seedFeedback(db, { userId: reporter });
    const promoted = await service.promoteFeedbackToBug({
      id: first,
      title: 'a',
      summary: 'b',
      moderatorId: moderator,
    });
    if (!promoted.ok) throw new Error('the first promotion should have succeeded');

    const result = await service.linkFeedbackToBug({
      id: second,
      bugId: promoted.bugId,
      moderatorId: moderator,
    });

    expect(result).toMatchObject({ ok: true, created: false });
    expect(await countRows(db, 'Bug')).toBe(1);
    expect((await readFeedback(db, second)).bugId).toBe(promoted.bugId);
  });

  it('reports a DELETED report as gone, not as a conflict over an issue', async () => {
    const id = await seedFeedback(db, { userId: reporter });
    const promoted = await service.promoteFeedbackToBug({
      id,
      title: 'a',
      summary: 'b',
      moderatorId: moderator,
    });
    if (!promoted.ok) throw new Error('the promotion should have succeeded');
    await db.query('DELETE FROM "Feedback" WHERE "id" = $1', [id]);

    const result = await service.linkFeedbackToBug({
      id,
      bugId: promoted.bugId,
      moderatorId: moderator,
    });

    expect(result).toEqual({ ok: false, reason: 'gone' });
  });

  it('refuses an issue number that does not exist, rather than writing a dangling link', async () => {
    const id = await seedFeedback(db, { userId: reporter });

    const result = await service.linkFeedbackToBug({ id, bugId: 4242, moderatorId: moderator });

    expect(result).toEqual({ ok: false, reason: 'no-such-bug' });
    expect((await readFeedback(db, id)).bugId).toBeNull();
  });
});

describe('reads', () => {
  it('lists newest first, joins the reporter and pages on a keyset', async () => {
    const older = await seedFeedback(db, {
      userId: reporter,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const newer = await seedFeedback(db, {
      userId: reporter,
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    const first = await service.getFeedbackList({ statuses: ['new'], limit: 1 });
    expect(first.items.map((r) => r.id)).toEqual([newer]);
    expect(first.items[0].username).toBe('kaeru');
    expect(first.nextCursor).not.toBeNull();

    const second = await service.getFeedbackList({
      statuses: ['new'],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.id)).toEqual([older]);
    expect(second.nextCursor).toBeNull();
  });

  it('treats an empty status selection as every status, not as none', async () => {
    await seedFeedback(db, { userId: reporter, status: 'dismissed' });

    expect((await service.getFeedbackList({ statuses: [] })).items).toHaveLength(1);
    expect((await service.getFeedbackList({ statuses: ['new'] })).items).toHaveLength(0);
  });

  it('filters by area', async () => {
    await seedFeedback(db, { userId: reporter, area: 'apps-marketplace' });
    await seedFeedback(db, { userId: reporter, area: 'bitdex-image-feed' });

    const rows = await service.getFeedbackList({ statuses: [], area: 'bitdex-image-feed' });
    expect(rows.items.map((r) => r.area)).toEqual(['bitdex-image-feed']);
  });

  it('counts only `new` for the sidebar badge', async () => {
    await seedFeedback(db, { userId: reporter });
    await seedFeedback(db, { userId: reporter, status: 'dismissed' });

    expect(await service.countNewFeedback()).toBe(1);
  });

  it('reports the areas that actually have rows, including a retired one', async () => {
    await seedFeedback(db, { userId: reporter, area: 'bitdex-image-feed' });

    expect(await service.getFeedbackAreas()).toEqual(['bitdex-image-feed']);
  });

  it('lists the sibling reports on one issue and excludes the row being read', async () => {
    const first = await seedFeedback(db, { userId: reporter });
    const second = await seedFeedback(db, { userId: reporter });
    const promoted = await service.promoteFeedbackToBug({
      id: first,
      title: 'a',
      summary: 'b',
      moderatorId: moderator,
    });
    if (!promoted.ok) throw new Error('the promotion should have succeeded');
    await service.linkFeedbackToBug({
      id: second,
      bugId: promoted.bugId,
      moderatorId: moderator,
    });

    const siblings = await service.getSiblingFeedback({
      bugId: promoted.bugId,
      excludeId: first,
    });
    expect(siblings.map((s) => s.id)).toEqual([second]);
  });

  it('surfaces the linked issue’s CURRENT title and status on the row', async () => {
    const id = await seedFeedback(db, { userId: reporter });
    const promoted = await service.promoteFeedbackToBug({
      id,
      title: 'Sort resets',
      summary: 'b',
      moderatorId: moderator,
    });
    if (!promoted.ok) throw new Error('the promotion should have succeeded');
    // What the inbound ClickUp webhook does to `Bug.status` — the entire point of routing a
    // promoted report through `Bug` is that the moderator sees this answer.
    await db.query('UPDATE "Bug" SET "status" = $1 WHERE "id" = $2', ['Complete', promoted.bugId]);

    const [row] = (await service.getFeedbackList({ statuses: [] })).items;
    expect(row.bugTitle).toBe('Sort resets');
    expect(row.bugStatus).toBe('Complete');
  });
});
