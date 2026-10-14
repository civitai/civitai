import { createHash } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FeedbackService from '~/server/services/feedback.service';
import type { CreatePlatformFeedbackInput } from '~/server/schema/platform-feedback.schema';
import { platformFeedbackServerStateSchema } from '~/server/schema/platform-feedback.schema';
import type { SessionUser } from '~/types/session';
// Relative, because `~` does not reach `apps/`. The moderator modules below import nothing through
// `$lib` at runtime for this reason.
import {
  feedbackKysely,
  freshAppFeedbackDb,
  seedUser,
} from '../../../../apps/moderator/src/lib/server/__tests__/feedback-pglite.harness';
import { splitPlatformContext } from '../../../../apps/moderator/src/lib/feedback-platform';

/**
 * 🔴 THE SEAM BETWEEN THE TWO WRITERS OF `context.server` AND ITS ONE READER. This service writes the
 * counters; the moderator app writes `resolution`; this service reads `resolution` back to the
 * reporting agents and decides regressions from it. Each side has its own suite, and neither can see
 * a key spelled differently on the other — so this runs the REAL moderator triage write and the REAL
 * service against one database.
 */

const mocks = vi.hoisted(() => ({
  isFeedbackAreaEnabled: vi.fn(),
  moderatorDb: { current: null as unknown },
}));

vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  isFeedbackAreaEnabled: mocks.isFeedbackAreaEnabled,
}));

// The moderator app's Kysely clients, pointed at the same PGlite database as the service.
vi.mock('../../../../apps/moderator/src/lib/server/db', () => ({
  get dbRead() {
    return mocks.moderatorDb.current;
  },
  get dbWrite() {
    return mocks.moderatorDb.current;
  },
}));

const { createPlatformFeedback, getPlatformFeedbackStatus } = await import(
  '../platform-feedback.service'
);
const { triageFeedback } = await import(
  '../../../../apps/moderator/src/lib/server/feedback.service'
);

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-02T11:30:00.000Z';
const NOTE = 'Fixed in 2.4.0 — update the CLI.';

let pg: PGlite;
let alice: number;
let bob: number;
let moderator: number;

const userOf = (id: number) => ({ id } as SessionUser);

const report = (version: string): CreatePlatformFeedbackInput['report'] => ({
  about: 'cli',
  kind: 'bug',
  ref: 'submit.server-refused',
  client: { name: 'civitai-cli', version },
  docUrl: 'https://developer.civitai.com/apps/submit',
  errorExcerpt: 'Error: REFUSED',
});

const send = (userId: number, version: string, message = 'submit refused with no reason') =>
  createPlatformFeedback({ user: userOf(userId), input: { message, report: report(version) } });

const status = (ref: string) =>
  getPlatformFeedbackStatus({ user: userOf(alice), input: { refs: [ref] } });

const clientOver = (target: PGlite | Transaction) => ({
  $queryRaw: async (q: Prisma.Sql) => (await target.query(q.text, q.values)).rows,
  $executeRaw: async (q: Prisma.Sql) => (await target.query(q.text, q.values)).affectedRows ?? 0,
  $executeRawUnsafe: async (text: string) => (await target.query(text)).affectedRows ?? 0,
});

const contextOf = async (id: number) =>
  (
    await pg.query<{ context: { report: unknown; server: Record<string, unknown> } }>(
      'SELECT "context" FROM "Feedback" WHERE "id" = $1',
      [id]
    )
  ).rows[0].context;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  pg = await freshAppFeedbackDb();
  mocks.moderatorDb.current = feedbackKysely(pg);
  alice = await seedUser(pg, 'alice');
  bob = await seedUser(pg, 'bob');
  moderator = await seedUser(pg, 'quinn');
  mocks.isFeedbackAreaEnabled.mockReset().mockResolvedValue(true);
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    pg.transaction((tx) => fn(clientOver(tx)))) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(clientOver(pg).$queryRaw as never);
});

afterEach(async () => {
  vi.useRealTimers();
  mocks.moderatorDb.current = null;
  await pg.close();
});

/** A report from alice and a repeat from bob, so the row carries samples and two reporters. */
async function reportedTwice() {
  const first = await send(alice, '2.3.4');
  await send(bob, '2.3.5', 'same refusal here');
  return { ref: first.ref, id: Number(first.ref.split('-')[0]) };
}

const resolve = (id: number, over: Partial<Parameters<typeof triageFeedback>[0]> = {}) =>
  triageFeedback({
    id,
    status: 'actioned',
    expectedStatus: 'new',
    resolution: {
      kind: 'set',
      expectedAt: null,
      fixedIn: { component: 'cli', version: '2.4.0' },
      publicNote: NOTE,
    },
    moderatorId: moderator,
    ...over,
  });

describe('a resolution the moderator app writes, read back by the service', () => {
  it('reads back as fixed, with that fixedIn and that note', async () => {
    const { ref, id } = await reportedTwice();
    vi.setSystemTime(new Date(T1));
    expect(await resolve(id)).toEqual({ ok: true, changed: true });

    expect(await status(ref)).toEqual([
      {
        ref,
        found: true,
        status: 'fixed',
        fixedIn: { component: 'cli', version: '2.4.0' },
        note: NOTE,
        reporters: 2,
        firstSeenAt: T0,
        updatedAt: T1,
      },
    ]);
  });

  it('reads back as addressed when the component has no version', async () => {
    const { ref, id } = await reportedTwice();
    await resolve(id, {
      resolution: {
        kind: 'set',
        expectedAt: null,
        fixedIn: { component: 'docs', version: '' },
        publicNote: null,
      },
    });
    expect(await status(ref)).toMatchObject([{ status: 'addressed', fixedIn: null, note: null }]);
  });

  it('fits the service’s own schema for the server state, field for field', async () => {
    const { id } = await reportedTwice();
    vi.setSystemTime(new Date(T1));
    await resolve(id);
    const { server } = await contextOf(id);
    expect(platformFeedbackServerStateSchema.parse(server).resolution).toEqual({
      fixedIn: { component: 'cli', version: '2.4.0' },
      publicNote: NOTE,
      at: T1,
    });
    // `byId` is the moderator app's own field; the reader strips it rather than failing on it.
    expect(server.resolution).toEqual({
      fixedIn: { component: 'cli', version: '2.4.0' },
      publicNote: NOTE,
      at: T1,
      byId: moderator,
    });
  });

  it('drives the regression branch: the fix version opens a new row, an older one counts', async () => {
    const { id } = await reportedTwice();
    await resolve(id);

    const older = await send(alice, '2.3.9');
    expect(older).toMatchObject({ duplicate: true, status: 'fixed' });

    const fixed = await send(bob, 'v2.4');
    expect(fixed).toMatchObject({ duplicate: false, status: 'received' });
    const newId = Number(fixed.ref.split('-')[0]);
    expect((await contextOf(newId)).server.regressionOf).toBe(id);
  });

  it('is gone from the readback once the moderator clears it', async () => {
    const { ref, id } = await reportedTwice();
    await resolve(id);
    expect(
      await triageFeedback({
        id,
        status: 'actioned',
        expectedStatus: 'actioned',
        resolution: { kind: 'clear', expectedAt: T0 },
        moderatorId: moderator,
      })
    ).toEqual({ ok: true, changed: true });
    expect(await status(ref)).toMatchObject([{ status: 'addressed', fixedIn: null, note: null }]);
    expect((await contextOf(id)).server).not.toHaveProperty('resolution');
  });
});

/**
 * 🔴 WHO CAN READ THE PUBLIC NOTE — pinned because the moderator form's copy states it. A
 * ref-keyed report's readback ref is `<id>-<first 8 hex of sha256("v1\n" + about + "\n" + ref)>`,
 * so anyone with the area enabled who knows the failure site can rebuild it, reporter or not.
 */
describe('the public note audience', () => {
  it('is readable by a user who never reported, from a ref rebuilt off the failure site', async () => {
    const { id } = await reportedTwice();
    await resolve(id);
    const suffix = createHash('sha256')
      .update('v1\ncli\nsubmit.server-refused')
      .digest('hex')
      .slice(0, 8);
    const stranger = await seedUser(pg, 'stranger');
    const [read] = await getPlatformFeedbackStatus({
      user: userOf(stranger),
      input: { refs: [`${id}-${suffix}`] },
    });
    expect(read).toMatchObject({ found: true, status: 'fixed', note: NOTE });
  });
});

describe('a row the service wrote, in the moderator panel', () => {
  it('splits into the panel fields without throwing, and leaves nothing unrecognised', async () => {
    const { id } = await reportedTwice();
    await resolve(id);
    const panel = splitPlatformContext(await contextOf(id));

    expect(panel.other).toBeNull();
    expect(panel.report.map((e) => e.key)).toEqual([
      'about',
      'kind',
      'ref',
      'client',
      'errorExcerpt',
    ]);
    expect(panel.doc).toEqual({
      text: 'https://developer.civitai.com/apps/submit',
      href: 'https://developer.civitai.com/apps/submit',
    });
    expect(panel).toMatchObject({
      reporters: 2,
      reports: 2,
      reporterIdCount: 2,
      firstSeenAt: T0,
      samples: [{ userId: bob, text: 'same refusal here', clientVersion: '2.3.5' }],
      resolution: {
        fixedIn: { component: 'cli', version: '2.4.0' },
        publicNote: NOTE,
        byId: moderator,
      },
    });
  });
});
