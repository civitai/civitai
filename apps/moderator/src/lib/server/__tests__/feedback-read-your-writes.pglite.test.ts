import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  feedbackKysely,
  freshAppFeedbackDb,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';
import { splitPlatformContext } from '$lib/feedback-platform';

/**
 * The panel's own reload, after its own save, against a replica that has NOT caught up.
 *
 * 🔴 TWO DATABASES, BECAUSE THE DEFECT ONLY EXISTS WHEN THERE ARE TWO. Every other feedback suite
 * binds `dbRead` and `dbWrite` to one PGlite, so a reload reading the replica is indistinguishable
 * from one reading the primary. Here `dbRead` is a second database seeded identically and never
 * written to — a replica frozen at the moment before the save — which is the state production's
 * read pool is in for however long replication lags.
 *
 * What it pins: a save (`?/triage`) followed by the `load` that `invalidateAll()` re-runs returns
 * the row AS SAVED, on both routes that render the panel. Read from the replica, the panel's
 * "What reporters read back", the status, and the "Save and mark actioned" button all come back as
 * they were before the click, and the next click posts the stale `expectedStatus` and is refused.
 */

const { handles } = vi.hoisted(() => ({
  handles: { primary: null as unknown, replica: null as unknown },
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!handles.replica) throw new Error('the replica client was not installed for this test');
    return handles.replica;
  },
  get dbWrite() {
    if (!handles.primary) throw new Error('the primary client was not installed for this test');
    return handles.primary;
  },
}));

const { triageAction } = await import('../feedback-actions');
const reportPage = await import('../../../routes/feedback/[id]/+page.server');
const queuePage = await import('../../../routes/feedback/+page.server');

const NOW = '2026-10-14T09:00:00.000Z';
const SERVER = {
  fingerprint: 'f00d',
  reporters: 4,
  reports: 6,
  firstSeenAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-05T11:11:11.000Z',
};
const REPORT = { about: 'cli', kind: 'bug', ref: 'submit.server-refused' };

let primary: PGlite;
let replica: PGlite;
let moderatorId: number;
let id: number;

/** Seeds the same rows into a database, in the same order, so both hand out the same ids. */
const seed = async (db: PGlite) => {
  const moderator = await seedUser(db, 'quinn');
  const reporter = await seedUser(db, 'reporter');
  const row = await seedFeedback(db, {
    userId: reporter,
    area: 'apps-platform',
    context: { report: REPORT, server: SERVER },
  });
  return { moderator, row };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  primary = await freshAppFeedbackDb();
  replica = await freshAppFeedbackDb();
  const a = await seed(primary);
  const b = await seed(replica);
  if (a.row !== b.row || a.moderator !== b.moderator)
    throw new Error('the two databases handed out different ids; the fixture is not a replica');
  ({ moderator: moderatorId, row: id } = a);
  handles.primary = feedbackKysely(primary);
  handles.replica = feedbackKysely(replica);
});

afterEach(async () => {
  vi.useRealTimers();
  handles.primary = null;
  handles.replica = null;
  await primary.close();
  await replica.close();
});

const GRANTS = { 'feedback.status.set': true } as const;

/** "Save and mark actioned", as the panel posts it. */
const saveAndMarkActioned = async () => {
  const data = new FormData();
  const form = {
    id: String(id),
    expectedStatus: 'new',
    status: 'actioned',
    resolution: 'set',
    expectedResolutionAt: '',
    fixedInComponent: 'cli',
    fixedInVersion: '2.4.0',
    publicNote: 'Fixed in 2.4.0 — update the CLI.',
  };
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  const result = await triageAction({
    request: { formData: async () => data },
    locals: { user: { id: moderatorId }, grants: GRANTS },
  } as never);
  expect(result).toEqual({ success: true, triaged: id });
};

/** What "What reporters read back" renders from, as the save above stores it. */
const expectSaved = (row: { status: string; context: unknown } | undefined) => {
  expect(row?.status).toBe('actioned');
  expect(splitPlatformContext(row?.context).resolution).toEqual({
    fixedIn: { component: 'cli', version: '2.4.0' },
    publicNote: 'Fixed in 2.4.0 — update the CLI.',
    at: NOW,
    byId: moderatorId,
  });
};

describe('the reload after a save', () => {
  it('runs against a replica that has not caught up (control)', async () => {
    await saveAndMarkActioned();
    const stale = await replica.query<{ status: string; context: unknown }>(
      'SELECT "status", "context" FROM "Feedback" WHERE "id" = $1',
      [id]
    );
    // Without this the two cases below could pass because the "replica" received the write too.
    expect(stale.rows[0].status).toBe('new');
    expect(splitPlatformContext(stale.rows[0].context).resolution).toBeNull();
  });

  it('shows the saved resolution on /feedback/<id>', async () => {
    await saveAndMarkActioned();
    const data = (await reportPage.load({
      params: { id: String(id) },
      locals: { grants: GRANTS },
    } as never)) as { row: { status: string; context: unknown } };
    expectSaved(data.row);
  });

  it('shows the saved resolution on the queue, in a view that still holds the row', async () => {
    await saveAndMarkActioned();
    const url = new URL(
      `http://moderator.test/feedback?status=new&status=actioned&area=apps-platform&open=${id}`
    );
    const data = (await queuePage.load({
      url,
      request: new Request(url),
      locals: { grants: GRANTS },
    } as never)) as { items: { id: number; status: string; context: unknown }[] };
    expectSaved(data.items.find((r) => r.id === id));
  });

  it('drops the row from the default `new` view once it is actioned', async () => {
    await saveAndMarkActioned();
    const url = new URL(`http://moderator.test/feedback?status=new&area=apps-platform&open=${id}`);
    const data = (await queuePage.load({
      url,
      request: new Request(url),
      locals: { grants: GRANTS },
    } as never)) as { items: { id: number }[]; openVisible: boolean };
    expect(data.items.map((r) => r.id)).not.toContain(id);
    expect(data.openVisible).toBe(false);
  });
});
