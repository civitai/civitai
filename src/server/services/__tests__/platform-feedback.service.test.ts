import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FeedbackService from '~/server/services/feedback.service';
import type { CreatePlatformFeedbackInput } from '~/server/schema/platform-feedback.schema';
import type { SessionUser } from '~/types/session';
// The REAL `Feedback` migrations applied to an in-process Postgres. Relative, because `~` does not
// reach `apps/`.
import {
  countRows,
  freshAppFeedbackDb,
  seedFeedback,
  seedUser,
} from '../../../../apps/moderator/src/lib/server/__tests__/feedback-pglite.harness';

/**
 * `platformFeedback` against real rows. Every statement the service sends runs on PGlite as the
 * parameterised text Prisma would send, so the counters, the caps and the area/suffix guards are
 * read back out of the table rather than out of a mock's arguments.
 *
 * Expected fingerprints are `sha256sum` output for the basis string written beside each, computed
 * outside this codebase.
 */

const mocks = vi.hoisted(() => ({ isFeedbackAreaEnabled: vi.fn() }));

vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  isFeedbackAreaEnabled: mocks.isFeedbackAreaEnabled,
}));

const { createPlatformFeedback, getPlatformFeedbackStatus, platformFeedbackFingerprint } =
  await import('../platform-feedback.service');

// printf 'v1\ncli\nsubmit.server-refused' | sha256sum
const FP_CLI_REF = 'ccb33a3af2f5981c140b409d7cd44a50d469685d7c0b5966d4c18609f3681819';
// printf 'v1\nsdk\nsubmit.server-refused' | sha256sum
const FP_SDK_REF = 'a66a5ec0431f914ef9fe713597760762c606df9a3c07604e69670c51465139fb';
// printf 'v1\nu1\ndocs\nthe docs page is wrong' | sha256sum
const FP_USER1_TEXT = 'dc7c46cd26c9c780fda32b34548ca2386231c91a74f418df8c57a45273596904';
// printf 'v1\nu2\ndocs\nthe docs page is wrong' | sha256sum
const FP_USER2_TEXT = 'bbc170329aac0c6e36d752d2497551abb1104f0c931503221277a07fd7db8227';

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-02T11:30:00.000Z';
const T2 = '2026-10-03T12:45:00.000Z';

const FIRST_MESSAGE = 'submit says REFUSED with no reason';
const SECOND_MESSAGE = 'same refusal here, the hint points at a page that 404s';
const PUBLIC_NOTE = 'Shipped a clearer refusal message.';
const TRIAGE_NOTE = 'internal: dup of the scopes thread, do not share';

const userOf = (id: number) => ({ id } as SessionUser);

const cliReport = (version = '2.3.4'): CreatePlatformFeedbackInput['report'] => ({
  about: 'cli',
  kind: 'bug',
  ref: 'submit.server-refused',
  client: { name: 'civitai-cli', version },
});

type ServerState = {
  fingerprint: string;
  reporters: number;
  reports: number;
  reporterIds: number[];
  firstSeenAt: string;
  lastSeenAt: string;
  samples: Array<{ userId: number; text: string; clientVersion: string }>;
  regressionOf?: number;
  reopenOf?: number;
  postCloseReporters?: number;
  postCloseFor?: string;
  resolution?: unknown;
};
type StoredRow = {
  id: number;
  area: string;
  userId: number;
  message: string;
  status: string;
  context: { report: unknown; server: ServerState };
};

let pg: PGlite;
/** Every statement the service sent, in order, as [text, values]. */
let statements: Array<[string, unknown[]]>;
/** The rows each of those statements returned, in the same order. */
let returned: Array<Array<Record<string, unknown>>>;
let alice: number;
let bob: number;

const run = async (target: PGlite | Transaction, text: string, values: unknown[] = []) => {
  statements.push([text, values]);
  const result = await target.query<Record<string, unknown>>(text, values);
  returned.push(result.rows);
  return result;
};

const resetLog = () => {
  statements = [];
  returned = [];
};

/** The keys of the `server` object a statement handed back to the service. */
const serverKeys = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => Object.keys(row.server as object).sort());

const clientOver = (target: PGlite | Transaction) => ({
  $queryRaw: async (q: Prisma.Sql) => (await run(target, q.text, q.values)).rows,
  $executeRaw: async (q: Prisma.Sql) => (await run(target, q.text, q.values)).affectedRows ?? 0,
  $executeRawUnsafe: async (text: string) => (await run(target, text)).affectedRows ?? 0,
});

const storedRows = async () =>
  (
    await pg.query<StoredRow>(
      'SELECT "id", "area", "userId", "message", "status", "context" FROM "Feedback" ORDER BY "id"'
    )
  ).rows;

const setStatus = (id: number, status: string) =>
  pg.query('UPDATE "Feedback" SET "status" = $1 WHERE "id" = $2', [status, id]);

/**
 * A status change as the moderator app makes it: every one stamps `handledAt`, and a move back to
 * `new` clears it. An ISO string, never a `Date` (see the harness header).
 */
const triage = (id: number, status: string, at: string) =>
  pg.query('UPDATE "Feedback" SET "status" = $1, "handledAt" = $2::timestamp WHERE "id" = $3', [
    status,
    status === 'new' ? null : at,
    id,
  ]);
const H1 = '2026-10-02T09:00:00.000';
const H2 = '2026-10-03T09:00:00.000';
const H3 = '2026-10-04T09:00:00.000';

/** What the moderator app will write; this service only reads it. */
const setResolution = (id: number, resolution: Record<string, unknown>) =>
  pg.query(
    `UPDATE "Feedback" SET "context" = jsonb_set("context", '{server,resolution}', $1::jsonb) WHERE "id" = $2`,
    [JSON.stringify(resolution), id]
  );

const create = (userId: number, input: CreatePlatformFeedbackInput) =>
  createPlatformFeedback({ user: userOf(userId), input });

const send = (userId: number, message = FIRST_MESSAGE, version?: string) =>
  create(userId, { message, report: cliReport(version) });

const status = (...refs: string[]) =>
  getPlatformFeedbackStatus({ user: userOf(alice), input: { refs } });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  resetLog();
  pg = await freshAppFeedbackDb();
  alice = await seedUser(pg, 'alice');
  bob = await seedUser(pg, 'bob');
  mocks.isFeedbackAreaEnabled.mockReset().mockResolvedValue(true);
  dbMock.dbWrite.$transaction.mockClear();
  dbMock.dbRead.$queryRaw.mockClear();
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    pg.transaction((tx) => fn(clientOver(tx)))) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(clientOver(pg).$queryRaw as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await pg.close();
});

describe('the fixtures', () => {
  it('seeds users 1 and 2, which the per-user fingerprints below are computed for', () => {
    expect([alice, bob]).toEqual([1, 2]);
  });
});

describe('platformFeedbackFingerprint', () => {
  it('keys a report with a ref on about + ref, for every user and message', () => {
    const report = { about: 'cli', ref: 'submit.server-refused' } as const;
    expect(platformFeedbackFingerprint({ userId: 1, message: 'a', report })).toBe(FP_CLI_REF);
    expect(platformFeedbackFingerprint({ userId: 2, message: 'b', report })).toBe(FP_CLI_REF);
    expect(
      platformFeedbackFingerprint({ userId: 1, message: 'a', report: { ...report, about: 'sdk' } })
    ).toBe(FP_SDK_REF);
  });

  it('keys a report without a ref on user + about + the normalised message', () => {
    const report = { about: 'docs' } as const;
    // Fullwidth letters (NFKC), mixed case, a tab, doubled and padding spaces.
    const noisy = '  The  Docs\tPage is ＷＲＯＮＧ ';
    expect(platformFeedbackFingerprint({ userId: 1, message: noisy, report })).toBe(FP_USER1_TEXT);
    expect(
      platformFeedbackFingerprint({ userId: 1, message: 'the docs page is wrong', report })
    ).toBe(FP_USER1_TEXT);
    expect(platformFeedbackFingerprint({ userId: 2, message: noisy, report })).toBe(FP_USER2_TEXT);
  });
});

describe('createPlatformFeedback — first report', () => {
  it('inserts one row and returns its ref', async () => {
    await expect(send(alice)).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: false,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 1,
      reports: 1,
    });
    expect(await storedRows()).toEqual([
      {
        id: 1,
        area: 'apps-platform',
        userId: 1,
        message: FIRST_MESSAGE,
        status: 'new',
        context: {
          report: cliReport(),
          server: {
            fingerprint: FP_CLI_REF,
            reporters: 1,
            reports: 1,
            reporterIds: [1],
            firstSeenAt: T0,
            lastSeenAt: T0,
            samples: [],
          },
        },
      },
    ]);
  });

  it('keeps reports with different fingerprints on different rows', async () => {
    const docs = (userId: number, message: string) =>
      create(userId, {
        message,
        report: { about: 'docs', kind: 'confusing', client: { name: 'other', version: '1' } },
      });
    expect((await docs(alice, 'The docs page is wrong')).ref).toBe('1-dc7c46cd');
    expect((await docs(bob, 'The docs page is wrong')).ref).toBe('2-bbc17032');
    expect((await send(alice)).ref).toBe('3-ccb33a3a');
    // Alice's own repeat, differing only in case and spacing, lands on her first row.
    await expect(docs(alice, 'the  DOCS page is wrong')).resolves.toMatchObject({
      ref: '1-dc7c46cd',
      duplicate: true,
      reporters: 1,
      reports: 2,
    });
    expect(await countRows(pg, 'Feedback')).toBe(3);
  });

  it('does not count a row from another area as the same report', async () => {
    await seedFeedback(pg, {
      userId: alice,
      area: 'site-bug-report',
      context: { server: { fingerprint: FP_CLI_REF, reporters: 9, reports: 9 } },
    });
    await expect(send(bob)).resolves.toMatchObject({ ref: '2-ccb33a3a', duplicate: false });
  });

  it('takes the fingerprint lock before it reads or writes the table', async () => {
    await send(alice);
    expect(statements.slice(0, 2)).toEqual([
      ["SET LOCAL lock_timeout = '3s'", []],
      [
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [`apps-platform:${FP_CLI_REF}`],
      ],
    ]);
    expect(statements.slice(2).every(([text]) => text.includes('"Feedback"'))).toBe(true);
    expect(statements).toHaveLength(4);
  });
});

describe('createPlatformFeedback — a repeat of an open report', () => {
  it('counts a repeat by the same user as a report, not as a reporter', async () => {
    await send(alice);
    vi.setSystemTime(new Date(T1));
    await expect(send(alice, 'still refused')).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 1,
      reports: 2,
    });
    vi.setSystemTime(new Date(T2));
    await expect(send(alice)).resolves.toMatchObject({ reporters: 1, reports: 3 });

    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect(row.message).toBe(FIRST_MESSAGE);
    expect(row.context.server).toEqual({
      fingerprint: FP_CLI_REF,
      reporters: 1,
      reports: 3,
      reporterIds: [1],
      firstSeenAt: T0,
      lastSeenAt: T2,
      samples: [],
    });
  });

  it('counts a second user as both, and keeps a sample of what they wrote', async () => {
    await send(alice);
    vi.setSystemTime(new Date(T1));
    await expect(send(bob, SECOND_MESSAGE, '2.5.0')).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 2,
      reports: 2,
    });

    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    // The row stays the first reporter's: their id, their message, their report.
    expect([row.userId, row.message]).toEqual([1, FIRST_MESSAGE]);
    expect(row.context.report).toEqual(cliReport());
    expect(row.context.server).toEqual({
      fingerprint: FP_CLI_REF,
      reporters: 2,
      reports: 2,
      reporterIds: [1, 2],
      firstSeenAt: T0,
      lastSeenAt: T1,
      samples: [{ userId: 2, text: SECOND_MESSAGE, clientVersion: '2.5.0' }],
    });
  });

  it('clips a sample to 300 characters', async () => {
    await send(alice);
    await send(bob, `${'x'.repeat(300)}TAIL`);
    const [row] = await storedRows();
    expect(row.context.server.samples.map((s) => s.text)).toEqual(['x'.repeat(300)]);
  });

  // The cut lands between the two halves of the emoji. Postgres rejects a lone surrogate in
  // jsonb, so without dropping the half this send fails rather than storing a sample.
  it('drops a surrogate pair the 300-character cut would split', async () => {
    await send(alice);
    await expect(send(bob, `${'x'.repeat(299)}\u{1F600}TAIL`)).resolves.toMatchObject({
      reporters: 2,
    });
    const [row] = await storedRows();
    expect(row.context.server.samples.map((s) => s.text)).toEqual(['x'.repeat(299)]);
  });

  it('keeps a whole surrogate pair that ends exactly at the cut', async () => {
    await send(alice);
    await send(bob, `${'x'.repeat(298)}\u{1F600}TAIL`);
    const [row] = await storedRows();
    expect(row.context.server.samples.map((s) => s.text)).toEqual([`${'x'.repeat(298)}\u{1F600}`]);
  });

  it('counts a repeat on a row whose server state holds only a fingerprint', async () => {
    await seedFeedback(pg, {
      userId: alice,
      area: 'apps-platform',
      context: { server: { fingerprint: FP_CLI_REF } },
    });
    vi.setSystemTime(new Date(T1));
    await expect(send(bob, SECOND_MESSAGE)).resolves.toMatchObject({
      ref: '1-ccb33a3a',
      duplicate: true,
      reporters: 1,
      reports: 1,
    });
    const [row] = await storedRows();
    expect(row.context.server).toEqual({
      fingerprint: FP_CLI_REF,
      reporters: 1,
      reports: 1,
      reporterIds: [2],
      lastSeenAt: T1,
      samples: [{ userId: 2, text: SECOND_MESSAGE, clientVersion: '2.3.4' }],
    });
  });

  it('reads the row back without reporter ids or samples', async () => {
    await send(alice);
    await send(bob, SECOND_MESSAGE);
    resetLog();
    await send(5001, 'a third reporter');
    // [SET, lock, find, update]: the two that read the row.
    expect(serverKeys([...returned[2], ...returned[3]])).toEqual([
      ['fingerprint', 'firstSeenAt', 'lastSeenAt', 'reporters', 'reports'],
      ['fingerprint', 'firstSeenAt', 'lastSeenAt', 'reporters', 'reports'],
    ]);
  });

  it('reports the status a moderator moved the row to', async () => {
    const { ref } = await send(alice);
    await setStatus(1, 'reviewed');
    await expect(send(bob)).resolves.toMatchObject({
      ref,
      duplicate: true,
      status: 'acknowledged',
    });
  });

  it('stops recording ids at 50 and samples at 5, and keeps counting', async () => {
    await send(alice);
    // 59 later reporters with ids no fixture row uses; only the first reporter is a FK.
    const later = Array.from({ length: 59 }, (_, i) => 5001 + i);
    for (const id of later) await send(id, `report from ${id}`);

    const [row] = await storedRows();
    const { server } = row.context;
    expect([server.reporters, server.reports]).toEqual([60, 60]);
    expect(server.reporterIds).toEqual([1, ...later.slice(0, 49)]);
    expect(server.samples).toEqual(
      later.slice(0, 5).map((id) => ({
        userId: id,
        text: `report from ${id}`,
        clientVersion: '2.3.4',
      }))
    );

    // A recorded reporter still does not inflate the count once the list is full…
    await expect(send(5049)).resolves.toMatchObject({ reporters: 60, reports: 61 });
    // …but one past the cap is no longer recognised, so `reporters` is an upper bound from here.
    await expect(send(5059)).resolves.toMatchObject({ reporters: 61, reports: 62 });
  });

  it('two concurrent first reports of one fingerprint produce one row', async () => {
    // PGlite is one connection and queues transactions, so this cannot interleave them: it pins
    // the outcome, not the lock. The lock statement itself is pinned above.
    const results = await Promise.all([send(alice), send(bob, SECOND_MESSAGE)]);
    expect(results.map((r) => r.ref)).toEqual(['1-ccb33a3a', '1-ccb33a3a']);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect([row.context.server.reporters, row.context.server.reports]).toEqual([2, 2]);
  });
});

describe('createPlatformFeedback — a repeat of a closed report', () => {
  it('dismissed: counts the repeat and returns not_planned with the public note', async () => {
    await send(alice);
    await setStatus(1, 'dismissed');
    await setResolution(1, { publicNote: 'Working as designed.', at: T1, byId: 77 });

    await expect(send(bob)).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'not_planned',
      fixedIn: null,
      note: 'Working as designed.',
      reporters: 2,
      reports: 2,
    });
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  it('clips an over-long public note to 300 characters, on both procedures', async () => {
    const { ref } = await send(alice);
    await setStatus(1, 'dismissed');
    await setResolution(1, { publicNote: `${'N'.repeat(300)}OVER` });
    expect((await send(bob)).note).toBe('N'.repeat(300));
    expect((await status(ref))[0]).toMatchObject({ note: 'N'.repeat(300) });
  });

  it('reads an empty public note as no note', async () => {
    const { ref } = await send(alice);
    await setResolution(1, { publicNote: '' });
    expect((await send(bob)).note).toBeNull();
    expect((await status(ref))[0]).toMatchObject({ note: null });
  });

  const fixedInCli = { fixedIn: { component: 'cli', version: '2.4.0' }, publicNote: PUBLIC_NOTE };

  async function actioned(resolution: Record<string, unknown>) {
    await send(alice);
    await setStatus(1, 'actioned');
    await setResolution(1, { ...resolution, at: T1, byId: 77 });
  }

  // `2.10.0` is the row a string comparison gets wrong: it sorts before `2.4.0`.
  it.each(['2.4.0', '2.10.0', '3.0.0-beta.1', 'v2.4.1', '2.5', '3', 'v3'])(
    'actioned: a reporter already on the fix (%s) opens a regression row',
    async (version) => {
      await actioned(fixedInCli);
      vi.setSystemTime(new Date(T2));

      await expect(send(bob, SECOND_MESSAGE, version)).resolves.toEqual({
        ref: '2-ccb33a3a',
        duplicate: false,
        status: 'received',
        fixedIn: null,
        note: null,
        reporters: 1,
        reports: 1,
      });

      const [original, regression, ...rest] = await storedRows();
      expect(rest).toEqual([]);
      // The fixed row is left exactly as it was.
      expect([original.status, original.context.server.reports]).toEqual(['actioned', 1]);
      expect(regression).toEqual({
        id: 2,
        area: 'apps-platform',
        userId: 2,
        message: SECOND_MESSAGE,
        status: 'new',
        context: {
          report: cliReport(version),
          server: {
            fingerprint: FP_CLI_REF,
            reporters: 1,
            reports: 1,
            reporterIds: [2],
            firstSeenAt: T2,
            lastSeenAt: T2,
            samples: [],
            regressionOf: 1,
          },
        },
      });

      // Later repeats land on the regression row, the newest for the fingerprint.
      await expect(send(alice, FIRST_MESSAGE, version)).resolves.toMatchObject({
        ref: '2-ccb33a3a',
        duplicate: true,
        reporters: 2,
      });
      expect(await countRows(pg, 'Feedback')).toBe(2);

      // The declared version is not verified, so the bound that matters is this one: once the
      // regression row exists, another high-version report from anyone lands on it too.
      await expect(send(5001, 'me too', '99.0.0')).resolves.toMatchObject({
        ref: '2-ccb33a3a',
        duplicate: true,
        reporters: 3,
      });
      expect(await countRows(pg, 'Feedback')).toBe(2);
    }
  );

  it.each([
    ['older', '2.3.9'],
    ['older bare major', '2'],
    ['a prerelease of the fix', '2.4.0-rc.1'],
    ['unparseable', '2.x-nightly'],
    ['unparseable with a numeric prefix', '2.4.0.1'],
  ])('actioned: a reporter with an %s version is told it is fixed', async (_label, version) => {
    await actioned(fixedInCli);

    await expect(send(bob, SECOND_MESSAGE, version)).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'fixed',
      fixedIn: { component: 'cli', version: '2.4.0' },
      note: PUBLIC_NOTE,
      reporters: 2,
      reports: 2,
    });
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  // A fix version is only a claim about the row once a moderator has closed it as fixed.
  it.each([
    ['new', 'received'],
    ['reviewed', 'acknowledged'],
    ['dismissed', 'not_planned'],
  ])('%s: a fix version on the row does not open a regression row', async (stored, readback) => {
    await send(alice);
    await setStatus(1, stored);
    await setResolution(1, fixedInCli);
    await expect(send(bob, SECOND_MESSAGE, '2.5.0')).resolves.toMatchObject({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: readback,
    });
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  it('actioned: a two-part fix version is compared as its .0 release', async () => {
    await actioned({ fixedIn: { component: 'cli', version: '2.4' } });
    await expect(send(bob, SECOND_MESSAGE, '2.3.9')).resolves.toMatchObject({
      ref: '1-ccb33a3a',
      status: 'fixed',
      fixedIn: { component: 'cli', version: '2.4' },
    });
    await expect(send(bob, SECOND_MESSAGE, '2.4.0')).resolves.toMatchObject({
      ref: '2-ccb33a3a',
      duplicate: false,
    });
  });

  it('actioned: an "other" client is never compared, even against an "other" fix', async () => {
    await actioned({ fixedIn: { component: 'other', version: '1.0.0' } });
    await expect(
      create(bob, {
        message: SECOND_MESSAGE,
        report: { ...cliReport(), client: { name: 'other', version: '9.9.9' } },
      })
    ).resolves.toMatchObject({ ref: '1-ccb33a3a', duplicate: true, status: 'fixed' });
  });

  it('actioned: an unparseable fix version never opens a regression row', async () => {
    await actioned({ fixedIn: { component: 'cli', version: 'next' } });
    await expect(send(bob, SECOND_MESSAGE, '9.9.9')).resolves.toMatchObject({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'fixed',
    });
  });

  it.each([
    ['a fix in another component', { name: 'civitai-mcp', version: '9.9.9' }],
    ['a client we do not version', { name: 'other', version: '9.9.9' }],
  ] as const)('actioned: %s is not compared against the client version', async (_label, client) => {
    await actioned(fixedInCli);
    await expect(
      create(bob, { message: SECOND_MESSAGE, report: { ...cliReport(), client } })
    ).resolves.toMatchObject({ ref: '1-ccb33a3a', duplicate: true, status: 'fixed' });
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  it('actioned: the mcp client is compared against an mcp fix', async () => {
    await actioned({ fixedIn: { component: 'mcp', version: '0.5.0' } });
    await expect(
      create(bob, {
        message: SECOND_MESSAGE,
        report: { ...cliReport(), client: { name: 'civitai-mcp', version: '0.5.0' } },
      })
    ).resolves.toMatchObject({ ref: '2-ccb33a3a', duplicate: false });
  });

  it.each(['', '   '])(
    'actioned with a blank fixed version (%j) reads as no fixedIn',
    async (v) => {
      await actioned({ fixedIn: { component: 'cli', version: v }, publicNote: 'Docs updated.' });
      await expect(send(bob, SECOND_MESSAGE, '9.9.9')).resolves.toMatchObject({
        ref: '1-ccb33a3a',
        duplicate: true,
        status: 'addressed',
        fixedIn: null,
      });
      expect(await status('1-ccb33a3a')).toMatchObject([{ status: 'addressed', fixedIn: null }]);
    }
  );

  it('actioned without a fixed version: addressed, and never a regression', async () => {
    await actioned({ publicNote: 'Docs updated.' });
    await expect(send(bob, SECOND_MESSAGE, '9.9.9')).resolves.toEqual({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'addressed',
      fixedIn: null,
      note: 'Docs updated.',
      reporters: 2,
      reports: 2,
    });
  });
});

/**
 * A report keyed on `report.ref` is one row for everyone, so a dismissed first report would
 * otherwise answer `not_planned` to every later reporter of that failure site for good.
 */
describe('createPlatformFeedback — a dismissed report reopens', () => {
  const NOT_PLANNED = { ref: '1-ccb33a3a', duplicate: true, status: 'not_planned' };
  const postClose = async () => (await storedRows())[0].context.server.postCloseReporters;

  async function dismissed() {
    await send(alice);
    await setStatus(1, 'dismissed');
  }

  it('counts each new reporter after the close once, however often they repeat', async () => {
    await dismissed();
    for (let i = 0; i < 5; i++) await expect(send(bob)).resolves.toMatchObject(NOT_PLANNED);
    // The original reporter was already on the row when it was closed.
    for (let i = 0; i < 5; i++) await expect(send(alice)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(1);
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  it('opens a new row for the fourth new reporter, not the third', async () => {
    await dismissed();
    await setResolution(1, { publicNote: 'Working as designed.' });
    // Real users for the third and fourth reporter: whoever opens a row becomes its `userId`, a
    // foreign key, so an early or late reopen must fail on the assertion and not on the insert.
    const carol = await seedUser(pg, 'carol');
    const dave = await seedUser(pg, 'dave');
    expect([carol, dave]).toEqual([3, 4]);

    await expect(send(5001)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(1);
    await expect(send(5002)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(2);
    // The third brings the count TO the threshold and is still answered from the closed row.
    await expect(send(carol)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(3);
    // At the threshold, someone already counted still cannot reopen it.
    await expect(send(carol)).resolves.toMatchObject(NOT_PLANNED);
    await expect(send(alice)).resolves.toMatchObject(NOT_PLANNED);
    expect(await countRows(pg, 'Feedback')).toBe(1);

    vi.setSystemTime(new Date(T2));
    await expect(send(dave, SECOND_MESSAGE)).resolves.toEqual({
      ref: '2-ccb33a3a',
      duplicate: false,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 1,
      reports: 1,
    });

    const [closed, reopened, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect([closed.status, closed.context.server.reports, closed.context.server.reporters]).toEqual(
      ['dismissed', 6, 4]
    );
    expect(closed.context.server.postCloseReporters).toBe(3);
    expect(reopened).toEqual({
      id: 2,
      area: 'apps-platform',
      userId: 4,
      message: SECOND_MESSAGE,
      status: 'new',
      context: {
        report: cliReport(),
        server: {
          fingerprint: FP_CLI_REF,
          reporters: 1,
          reports: 1,
          reporterIds: [4],
          firstSeenAt: T2,
          lastSeenAt: T2,
          samples: [],
          reopenOf: 1,
        },
      },
    });

    // Later reports, from anyone, land on the reopened row.
    await expect(send(5005)).resolves.toMatchObject({
      ref: '2-ccb33a3a',
      duplicate: true,
      status: 'received',
      reporters: 2,
    });
    await expect(send(5001)).resolves.toMatchObject({ ref: '2-ccb33a3a', duplicate: true });
    expect(await countRows(pg, 'Feedback')).toBe(2);
  });

  it('getStatus does not expose that a row is a reopening', async () => {
    await dismissed();
    for (const id of [5001, 5002, 5003, await seedUser(pg, 'carol')]) await send(id);
    const result = await status('2-ccb33a3a', '1-ccb33a3a');
    expect(result.map((r) => [r.ref, r.found, 'status' in r && r.status])).toEqual([
      ['2-ccb33a3a', true, 'received'],
      ['1-ccb33a3a', true, 'not_planned'],
    ]);
    for (const entry of result)
      expect(Object.keys(entry).sort()).toEqual([
        'firstSeenAt',
        'fixedIn',
        'found',
        'note',
        'ref',
        'reporters',
        'status',
        'updatedAt',
      ]);
    expect(JSON.stringify(result)).not.toMatch(/reopenOf|postClose/);
  });

  // 47 ids at the close: the three who reach the threshold also fill the list, so the next
  // reporter is unknown to the row but cannot be shown to be new.
  it('does not reopen for a reporter the full list cannot vouch for', async () => {
    await send(alice);
    for (let id = 5001; id <= 5046; id++) await send(id);
    await setStatus(1, 'dismissed');
    for (const id of [6001, 6002, 6003]) await send(id);
    const [row] = await storedRows();
    expect([row.context.server.reporterIds.length, row.context.server.postCloseReporters]).toEqual([
      50, 3,
    ]);

    await expect(send(await seedUser(pg, 'carol'))).resolves.toMatchObject(NOT_PLANNED);
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  it('does not reopen a row a moderator has moved out of dismissed', async () => {
    await dismissed();
    for (const id of [5001, 5002, 5003]) await send(id);
    expect(await postClose()).toBe(3);
    await setStatus(1, 'reviewed');

    const carol = await seedUser(pg, 'carol');
    await expect(send(carol)).resolves.toMatchObject({
      ref: '1-ccb33a3a',
      duplicate: true,
      status: 'acknowledged',
    });
    expect(await postClose()).toBe(3);
    expect(await countRows(pg, 'Feedback')).toBe(1);

    // Dismissed again: the count belongs to the close before, so this starts from nothing.
    await triage(1, 'dismissed', H3);
    const dave = await seedUser(pg, 'dave');
    await expect(send(dave)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(1);
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  /**
   * The count is for ONE close. `carried` reporters arrive after the first dismissal, the
   * moderator reconsiders and dismisses again, and the second close must need the full three.
   * With 3 carried this is the sequence where a single account undid a considered re-dismissal.
   */
  it.each([1, 2, 3])(
    'a second dismissal needs three new reporters again, with %i counted before it',
    async (carried) => {
      await send(alice);
      await triage(1, 'dismissed', H1);
      for (let i = 0; i < carried; i++) await send(5001 + i);
      expect(await postClose()).toBe(carried);

      await triage(1, 'reviewed', H2);
      await expect(send(5010)).resolves.toMatchObject({ status: 'acknowledged' });
      await triage(1, 'dismissed', H3);

      const [carol, dave, erin, frank] = [
        await seedUser(pg, 'carol'),
        await seedUser(pg, 'dave'),
        await seedUser(pg, 'erin'),
        await seedUser(pg, 'frank'),
      ];
      await expect(send(carol)).resolves.toMatchObject(NOT_PLANNED);
      expect(await postClose()).toBe(1);
      await expect(send(dave)).resolves.toMatchObject(NOT_PLANNED);
      await expect(send(erin)).resolves.toMatchObject(NOT_PLANNED);
      expect(await postClose()).toBe(3);
      expect(await countRows(pg, 'Feedback')).toBe(1);

      await expect(send(frank)).resolves.toMatchObject({ ref: '2-ccb33a3a', duplicate: false });
      expect(await countRows(pg, 'Feedback')).toBe(2);
    }
  );

  it('a second dismissal with no report in between also starts from nothing', async () => {
    await send(alice);
    await triage(1, 'dismissed', H1);
    for (const id of [5001, 5002, 5003]) await send(id);
    await triage(1, 'reviewed', H2);
    await triage(1, 'dismissed', H3);
    await expect(send(await seedUser(pg, 'carol'))).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(1);
    expect(await countRows(pg, 'Feedback')).toBe(1);
  });

  // A count stored without saying which close it is for (or for a row nobody stamped) cannot be
  // attributed to the current close, so it is not trusted.
  it.each([
    ['a stamped row', H1],
    ['a row with no handledAt', null],
  ])('does not trust a stored count that names no close, on %s', async (_label, handledAt) => {
    await seedFeedback(pg, {
      userId: alice,
      area: 'apps-platform',
      status: 'dismissed',
      context: {
        server: {
          fingerprint: FP_CLI_REF,
          reporterIds: [1],
          reporters: 1,
          reports: 1,
          postCloseReporters: 3,
        },
      },
    });
    await pg.query('UPDATE "Feedback" SET "handledAt" = $1::timestamp WHERE "id" = 1', [handledAt]);

    const carol = await seedUser(pg, 'carol');
    await expect(send(carol)).resolves.toMatchObject(NOT_PLANNED);
    expect(await postClose()).toBe(1);
    expect(await countRows(pg, 'Feedback')).toBe(1);
    // From there it counts normally, on a row with no handledAt as well.
    await send(5001);
    await send(5002);
    expect(await postClose()).toBe(3);
    await expect(send(await seedUser(pg, 'dave'))).resolves.toMatchObject({
      ref: '2-ccb33a3a',
      duplicate: false,
    });
  });

  it('names the close a count is for', async () => {
    await send(alice);
    await triage(1, 'dismissed', H1);
    await send(bob);
    // 2026-10-02T09:00:00.000Z in epoch milliseconds.
    expect((await storedRows())[0].context.server.postCloseFor).toBe('1790931600000');
  });

  it.each(['new', 'reviewed', 'actioned'])('a %s row never reopens', async (stored) => {
    await send(alice);
    await setStatus(1, stored);
    for (const id of [5001, 5002, 5003, 5004, 5005, 5006])
      await expect(send(id)).resolves.toMatchObject({ ref: '1-ccb33a3a', duplicate: true });
    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect(row.context.server).not.toHaveProperty('postCloseReporters');
    expect(row.context.server.reporters).toBe(7);
  });

  // With the id list full nobody can be shown to be new, so nobody past it counts towards a
  // reopen. 49 ids at the close leaves room for exactly one.
  it('stops counting towards a reopen once the reporter list is full', async () => {
    await send(alice);
    for (let id = 5001; id <= 5048; id++) await send(id);
    await setStatus(1, 'dismissed');

    for (const id of [6001, 6002, 6003, 6004, 6005, 6006])
      await expect(send(id)).resolves.toMatchObject(NOT_PLANNED);

    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect(row.context.server.reporterIds).toHaveLength(50);
    expect(row.context.server.reporterIds[49]).toBe(6001);
    expect(row.context.server.postCloseReporters).toBe(1);
  });
});

describe('getPlatformFeedbackStatus', () => {
  /** Two reporters, a sample, a triage note, a handler and a resolution: everything a row can hold. */
  async function fullRow() {
    await send(alice);
    vi.setSystemTime(new Date(T1));
    await send(bob, SECOND_MESSAGE, '2.5.0');
    await pg.query(
      `UPDATE "Feedback" SET "status" = 'actioned', "triageNote" = $1, "handledById" = $2,
              "handledAt" = '2026-10-04T08:15:00.000' WHERE "id" = 1`,
      [TRIAGE_NOTE, bob]
    );
    await setResolution(1, {
      fixedIn: { component: 'cli', version: '2.4.0' },
      publicNote: PUBLIC_NOTE,
      at: T2,
      byId: 77,
    });
  }

  it('returns exactly the public fields of a report', async () => {
    await fullRow();
    const result = await status('1-ccb33a3a');

    expect(result).toEqual([
      {
        ref: '1-ccb33a3a',
        found: true,
        status: 'fixed',
        fixedIn: { component: 'cli', version: '2.4.0' },
        note: PUBLIC_NOTE,
        reporters: 2,
        firstSeenAt: T0,
        updatedAt: '2026-10-04T08:15:00.000Z',
      },
    ]);
    // `toEqual` ignores a key holding `undefined`; the key list does not.
    expect(Object.keys(result[0]).sort()).toEqual([
      'firstSeenAt',
      'fixedIn',
      'found',
      'note',
      'ref',
      'reporters',
      'status',
      'updatedAt',
    ]);
    const wire = JSON.stringify(result);
    for (const secret of [FIRST_MESSAGE, SECOND_MESSAGE, TRIAGE_NOTE, FP_CLI_REF, '77', '2.5.0'])
      expect(wire).not.toContain(secret);
  });

  it('reads only the public part of the row, in one query on the primary', async () => {
    await fullRow();
    resetLog();
    await status('1-ccb33a3a');
    expect(statements.map(([, values]) => values)).toEqual([[1, 'apps-platform']]);
    expect(returned[0].map((row) => Object.keys(row).sort())).toEqual([
      ['handledAtMs', 'id', 'server', 'status'],
    ]);
    expect(serverKeys(returned[0])).toEqual([
      ['fingerprint', 'firstSeenAt', 'lastSeenAt', 'reporters', 'reports', 'resolution'],
    ]);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['new', undefined, 'received', null],
    ['reviewed', undefined, 'acknowledged', null],
    [
      'actioned',
      { fixedIn: { component: 'sdk', version: '0.9.2' } },
      'fixed',
      { component: 'sdk', version: '0.9.2' },
    ],
    ['actioned', { publicNote: PUBLIC_NOTE }, 'addressed', null],
    ['dismissed', undefined, 'not_planned', null],
  ] as const)('maps %s (%j) to %s', async (stored, resolution, expected, fixedIn) => {
    await send(alice);
    await setStatus(1, stored);
    if (resolution) await setResolution(1, resolution);
    expect(await status('1-ccb33a3a')).toMatchObject([
      {
        found: true,
        status: expected,
        fixedIn,
        note: resolution && 'publicNote' in resolution ? PUBLIC_NOTE : null,
      },
    ]);
  });

  it('dates an untouched report by its last send', async () => {
    await send(alice);
    vi.setSystemTime(new Date(T1));
    await send(alice);
    expect(await status('1-ccb33a3a')).toMatchObject([{ firstSeenAt: T0, updatedAt: T1 }]);
  });

  // Each row makes a different one of the three timestamps the latest.
  it.each([
    ['the last send', '2026-10-01T10:30:00.000', '2026-10-01T11:00:00.000Z', T2],
    [
      'the resolution',
      '2026-10-05T08:00:00.000',
      '2026-10-09T09:09:09.000Z',
      '2026-10-09T09:09:09.000Z',
    ],
    ['the resolution, never handled', null, '2026-10-09T09:09:09.000Z', '2026-10-09T09:09:09.000Z'],
    [
      'the triage',
      '2026-10-12T07:07:07.000',
      '2026-10-09T09:09:09.000Z',
      '2026-10-12T07:07:07.000Z',
    ],
  ])('updatedAt is %s when that is latest', async (_label, handledAt, resolvedAt, expected) => {
    await send(alice);
    await pg.query('UPDATE "Feedback" SET "handledAt" = $1::timestamp WHERE "id" = 1', [handledAt]);
    await setResolution(1, { at: resolvedAt });
    vi.setSystemTime(new Date(T2));
    await send(alice);
    expect(await status('1-ccb33a3a')).toMatchObject([{ firstSeenAt: T0, updatedAt: expected }]);
  });

  it.each([
    ['no server state', {}],
    ['a null server', { server: null }],
    ['an array server', { server: [FP_CLI_REF] }],
    ['a string server', { server: FP_CLI_REF }],
    ['a non-string fingerprint', { server: { fingerprint: 12345678 } }],
  ])(
    'answers found:false for a row with %s, and still answers the rest',
    async (_label, context) => {
      const broken = await seedFeedback(pg, { userId: alice, area: 'apps-platform', context });
      expect(broken).toBe(1);
      await send(bob);
      expect(await status('1-ccb33a3a', '1-12345678', '1-', '2-ccb33a3a')).toMatchObject([
        { ref: '1-ccb33a3a', found: false },
        { ref: '1-12345678', found: false },
        { ref: '1-', found: false },
        { ref: '2-ccb33a3a', found: true },
      ]);
    }
  );

  /** Overwrites keys of the stored server state with values this service would never write. */
  const corrupt = (patch: Record<string, unknown>) =>
    pg.query(
      `UPDATE "Feedback" SET "context" = jsonb_set("context", '{server}', ("context"->'server') || $1::jsonb) WHERE "id" = 1`,
      [JSON.stringify(patch)]
    );

  it('reads every malformed field as absent instead of failing', async () => {
    await send(alice);
    await send(bob);
    await setStatus(1, 'actioned');
    await corrupt({
      reporters: 'many',
      reports: 'many',
      firstSeenAt: 5,
      lastSeenAt: 5,
      resolution: 'fixed in 2.4.0',
    });
    expect(await status('1-ccb33a3a')).toEqual([
      {
        ref: '1-ccb33a3a',
        found: true,
        status: 'addressed',
        fixedIn: null,
        note: null,
        reporters: 1,
        firstSeenAt: null,
        updatedAt: null,
      },
    ]);
  });

  // One bad field at a time: the rest of the resolution must still be read.
  it.each([
    [
      'a non-string note',
      { fixedIn: { component: 'cli', version: '2.4.0' }, publicNote: 7, at: T1 },
      {
        status: 'fixed',
        fixedIn: { component: 'cli', version: '2.4.0' },
        note: null,
        updatedAt: T1,
      },
    ],
    [
      'a malformed fixedIn',
      { fixedIn: '2.4.0', publicNote: PUBLIC_NOTE, at: T1 },
      { status: 'addressed', fixedIn: null, note: PUBLIC_NOTE, updatedAt: T1 },
    ],
    [
      'a non-string date',
      { fixedIn: { component: 'cli', version: '2.4.0' }, publicNote: PUBLIC_NOTE, at: 5 },
      {
        status: 'fixed',
        fixedIn: { component: 'cli', version: '2.4.0' },
        note: PUBLIC_NOTE,
        updatedAt: T0,
      },
    ],
    [
      'a date that does not parse',
      {
        fixedIn: { component: 'cli', version: '2.4.0' },
        publicNote: PUBLIC_NOTE,
        at: 'last tuesday',
      },
      {
        status: 'fixed',
        fixedIn: { component: 'cli', version: '2.4.0' },
        note: PUBLIC_NOTE,
        updatedAt: T0,
      },
    ],
  ])('reads the rest of a resolution with %s', async (_label, resolution, expected) => {
    await send(alice);
    await setStatus(1, 'actioned');
    await corrupt({ resolution });
    expect(await status('1-ccb33a3a')).toMatchObject([{ found: true, ...expected }]);
  });

  it('looks up the largest id a ref can hold, and no larger', async () => {
    await send(alice);
    resetLog();
    expect(await status('2147483647-ccb33a3a')).toEqual([
      { ref: '2147483647-ccb33a3a', found: false },
    ]);
    expect(statements.map(([, values]) => values)).toEqual([[2147483647, 'apps-platform']]);
    resetLog();
    expect(await status('2147483648-ccb33a3a')).toEqual([
      { ref: '2147483648-ccb33a3a', found: false },
    ]);
    expect(statements).toEqual([]);
  });

  it('answers found:false, and nothing else, for a ref whose suffix does not match', async () => {
    await fullRow();
    expect(await status('1-ccb33a3b', '1-a66a5ec0')).toEqual([
      { ref: '1-ccb33a3b', found: false },
      { ref: '1-a66a5ec0', found: false },
    ]);
  });

  it.each([
    '2-ccb33a3a',
    'ccb33a3a',
    '1',
    '1-',
    '1-CCB33A3A',
    '01-ccb33a3a',
    '99999999999-ccb33a3a',
    '2147483648-ccb33a3a',
    "1-ccb33a3a' OR 1=1",
  ])('answers found:false for an unknown or malformed ref (%s)', async (ref) => {
    await send(alice);
    expect(await status(ref)).toEqual([{ ref, found: false }]);
  });

  it('never returns a row from another area, even with a matching suffix', async () => {
    await send(alice);
    const other = await seedFeedback(pg, {
      userId: alice,
      area: 'site-bug-report',
      context: { server: { fingerprint: FP_SDK_REF, reporters: 9, reports: 9 } },
    });
    expect(other).toBe(2);
    expect(await status('2-a66a5ec0', '1-ccb33a3a')).toMatchObject([
      { ref: '2-a66a5ec0', found: false },
      { ref: '1-ccb33a3a', found: true },
    ]);
  });

  it('answers each ref in the order asked, repeats included', async () => {
    await send(alice);
    await create(bob, { message: 'sdk too', report: { ...cliReport(), about: 'sdk' } });
    resetLog();
    const result = await status('2-a66a5ec0', '9-00000000', '1-ccb33a3a', '2-a66a5ec0');
    // Each id is looked up once however often it is asked for.
    expect(statements.map(([, values]) => values)).toEqual([[2, 9, 1, 'apps-platform']]);
    expect(result.map((r) => [r.ref, r.found])).toEqual([
      ['2-a66a5ec0', true],
      ['9-00000000', false],
      ['1-ccb33a3a', true],
      ['2-a66a5ec0', true],
    ]);
  });

  it('sends no query when no ref is well-formed', async () => {
    expect(await status('nope', 'also-nope')).toEqual([
      { ref: 'nope', found: false },
      { ref: 'also-nope', found: false },
    ]);
    expect(statements).toEqual([]);
  });
});

describe('the area flag', () => {
  const REFUSAL = { code: 'FORBIDDEN', message: 'Feedback is not being collected here right now.' };

  it('create refuses with the area off, before any transaction', async () => {
    mocks.isFeedbackAreaEnabled.mockResolvedValue(false);
    await expect(send(alice)).rejects.toMatchObject(REFUSAL);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(await countRows(pg, 'Feedback')).toBe(0);
  });

  it('getStatus refuses with the area off, before any query', async () => {
    await send(alice);
    resetLog();
    mocks.isFeedbackAreaEnabled.mockResolvedValue(false);
    await expect(status('1-ccb33a3a')).rejects.toMatchObject(REFUSAL);
    expect(statements).toEqual([]);
  });

  it('evaluates the apps-platform flag for the caller, outside the transaction', async () => {
    await send(bob);
    expect(mocks.isFeedbackAreaEnabled.mock.calls).toEqual([
      [{ area: 'apps-platform', user: { id: 2 } }],
    ]);
    expect(mocks.isFeedbackAreaEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });
});
