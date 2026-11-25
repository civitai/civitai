import { Prisma, PrismaClient } from '@prisma/client';
import { Kysely, PostgresDialect } from 'kysely';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import {
  clearFpRestricted,
  leaseFpMirrorRows,
  markFpMirrorDue,
  markFpReconciled,
  readFpMirrorFacts,
  recordFpPush,
} from '@civitai/db-queries/feature-page-comments';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import {
  clearCommentV3TosViolationIn,
  deleteOwnCommentV3,
} from '~/server/services/commentv3/moderation.service';
import { fpEditHooks } from '~/server/services/feature-pages/comments.service';
import { refuseFpCommentIn } from '~/server/services/feature-pages/mirror.service';
import { hideFlaggedFpComment } from '~/server/services/commentv3/moderation.service';
import { createReport } from '~/server/services/report.service';
import { restoreCommentsIn } from '~/server/services/scam-cleanup.service';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';
import {
  type CommentGoneCause,
  deleteComments,
  getStoredComment,
  prismaRunner,
  setCommentFlags,
} from '~/server/services/commentv3/write.service';
import { COMMENT_V3_MIGRATIONS, SETUP } from '~/server/services/feature-pages/__tests__/fp-harness';
import { lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';

/**
 * Feature Pages comment writers racing on real Postgres: two connections, each in its own
 * transaction, through the exported writers. A single-connection database cannot show any of this.
 * Needs APPDATA_TEST_DATABASE_URL (a throwaway server); the suite creates and drops its own database.
 */
const URL_BASE = process.env.APPDATA_TEST_DATABASE_URL;
const DB_NAME = 'fp_hide_state_test';

describe('a real Postgres for the Feature Pages hide state', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(URL_BASE, 'these races need APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

type Tx = ReturnType<typeof txOf>;
/** A connection as the slice of a Prisma transaction the writers use. */
const txOf = (c: Client) => {
  const rows = async (text: string, params: unknown[]) => (await c.query(text, params)).rows;
  return {
    $queryRawUnsafe: async <R>(text: string, ...params: unknown[]) =>
      (await rows(text, params)) as R,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const s = Prisma.sql(strings, ...values);
      return (await c.query(s.text, s.values)).rows;
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const s = Prisma.sql(strings, ...values);
      return (await c.query(s.text, s.values)).rowCount ?? 0;
    },
    textScanHold: {
      findMany: async ({ where }: { where: { entityType: string; entityId: number } }) =>
        rows(
          `SELECT status, "textHash", meta FROM "TextScanHold"
           WHERE "entityType" = $1 AND "entityId" = $2 AND label = 'csam'`,
          [where.entityType, where.entityId]
        ),
    },
    entityModeration: {
      findUnique: async ({
        where,
      }: {
        where: { entityType_entityId: { entityType: string; entityId: number } };
      }) =>
        (
          await rows(
            `SELECT status, "triggeredLabels", result FROM "EntityModeration"
             WHERE "entityType" = $1 AND "entityId" = $2`,
            [where.entityType_entityId.entityType, where.entityType_entityId.entityId]
          )
        )[0] ?? null,
    },
  };
};
const runner = (c: Client) => prismaRunner(txOf(c) as never);

describe.skipIf(!URL_BASE)('Feature Pages comment writers on real Postgres', () => {
  let c0: Client;
  let c1: Client;
  let c2: Client;
  let pool: Pool;
  let kysely: Kysely<DB>;
  let prisma: PrismaClient;
  const pids = new Map<Client, number>();

  beforeAll(async () => {
    const admin = new Client({ connectionString: URL_BASE });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    const url = new URL(URL_BASE!);
    url.pathname = `/${DB_NAME}`;
    const connect = async () => {
      const c = new Client({ connectionString: url.toString() });
      await c.connect();
      pids.set(c, (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return c;
    };
    c0 = await connect();
    await c0.query(FIXTURE);
    await c0.query(SETUP);
    for (const name of COMMENT_V3_MIGRATIONS) await c0.query(migration(name));
    const [value, rest] = migration('20271125140000_feature_page_comments').split('\n-- 2.');
    await c0.query(value);
    await c0.query(`-- 2.${rest}`);
    // Every column the report path's Prisma queries read or write.
    await c0.query(
      `ALTER TABLE "Report" ADD COLUMN "userId" int NOT NULL DEFAULT 1,
         ADD COLUMN "createdAt" timestamp(3) NOT NULL DEFAULT now(), ADD COLUMN details jsonb,
         ADD COLUMN "internalNotes" text, ADD COLUMN "previouslyReviewedCount" int NOT NULL DEFAULT 0,
         ADD COLUMN "alsoReportedBy" int[] NOT NULL DEFAULT '{}', ADD COLUMN "statusSetAt" timestamp(3),
         ADD COLUMN "statusSetBy" int`
    );
    c1 = await connect();
    c2 = await connect();
    const prismaUrl = new URL(url);
    prismaUrl.searchParams.set('connection_limit', '3');
    prisma = new PrismaClient({ datasources: { db: { url: prismaUrl.toString() } } });
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }, 120_000);

  afterAll(async () => {
    await kysely?.destroy();
    await prisma?.$disconnect();
    for (const c of [c0, c1, c2]) await c?.end();
  });

  beforeEach(async () => {
    for (const c of [c1, c2]) await c.query('ROLLBACK').catch(() => undefined);
    await c0.query(
      `TRUNCATE "FeaturePageCommentMirror", "CommentV3Report", "Report", "TextScanHold",
         "EntityModeration", "CommentV3" CASCADE`
    );
  });

  /** A shown comment, pushed visible to the platform; scanned clear unless told otherwise. */
  const seed = async ({ scanned = true }: { scanned?: boolean } = {}) => {
    const [{ id: topicId }] = (
      await c0.query(
        `INSERT INTO "FeaturePageTopic"(urn, kind) VALUES ('urn:fp:requests/x', 'request')
         ON CONFLICT (urn) DO UPDATE SET urn = EXCLUDED.urn RETURNING id`
      )
    ).rows;
    await c0.query(
      `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('featurePage', $1)
       ON CONFLICT DO NOTHING`,
      [topicId]
    );
    const [{ id }] = (
      await c0.query(
        `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content)
         VALUES ('featurePage', $1, 2, '<p>evidence</p>') RETURNING id`,
        [topicId]
      )
    ).rows;
    await c0.query(
      `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", urn, "pushedState")
       VALUES ($1, 2, $2, $3, 'visible')`,
      [id, `r-${id}`, `urn:c${id}`]
    );
    if (scanned)
      await c0.query(
        `INSERT INTO "EntityModeration"("entityType", "entityId", status, result)
         VALUES ('CommentV3', $1, 'Succeeded', '{}')`,
        [id]
      );
    return id as number;
  };

  const state = async (id: number) =>
    (
      await c0.query(
        `SELECT c.hidden, c."tosViolation", c."deletedAt" IS NOT NULL AS deleted,
                c.content, c.id IS NOT NULL AS present,
                m."goneCause", m."nextPushAt" IS NOT NULL AND m."nextPushAt" <= now() AS due
         FROM "FeaturePageCommentMirror" m LEFT JOIN "CommentV3" c ON c.id = m."commentId"
         WHERE m."commentId" = $1`,
        [id]
      )
    ).rows[0];

  /** Whether the mirror owes the platform a restriction (lease priority and the alert clock). */
  const restricted = async (id: number) =>
    (
      await c0.query(
        `SELECT "restrictedAt" IS NOT NULL AS r FROM "FeaturePageCommentMirror" WHERE "commentId" = $1`,
        [id]
      )
    ).rows[0].r as boolean;

  /** Resolves once `c` (a connection or a backend pid) is waiting on a lock, or `settled` has settled. */
  const waitingOrDone = async (c: Client | number, settled: { done: boolean }) => {
    for (let i = 0; i < 200; i++) {
      if (settled.done) return 'done';
      const { rows } = await c0.query(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [typeof c === 'number' ? c : pids.get(c)]
      );
      if (rows[0]?.wait_event_type === 'Lock') return 'waiting';
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('neither waiting nor done');
  };

  type Step = (tx: Tx, c: Client) => Promise<unknown>;
  /**
   * `first` runs on c1 and holds its transaction open; `second` starts on c2 meanwhile; then c1
   * commits and c2 finishes. Returns how the second ended and whether it had to wait for the first.
   */
  const race = async (first: Step, second: Step) => {
    await c1.query('BEGIN');
    await first(txOf(c1), c1);
    await c2.query('BEGIN');
    const settled = { done: false };
    const outcome = second(txOf(c2), c2).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    void outcome.finally(() => (settled.done = true));
    const waited = (await waitingOrDone(c2, settled)) === 'waiting';
    await c1.query('COMMIT');
    const result = await outcome;
    await c2.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return { ...result, waited };
  };

  // The writers, each through its exported function.
  const flags =
    (f: { hidden?: boolean; tosViolation?: boolean }): Step =>
    (_tx, c) =>
      setCommentFlags(runner(c), [currentId], f);
  const gone =
    (cause: Exclude<CommentGoneCause, 'author'>): Step =>
    (_tx, c) =>
      deleteComments(runner(c), [currentId], cause);
  const authorDelete: Step = (tx) =>
    deleteOwnCommentV3(tx as never, { id: currentId, entityType: 'featurePage' });
  /** A report as the report path writes it: the row, then its link to the comment (FK). */
  const report: Step = async (_tx, c) => {
    const [{ id }] = (await c.query(`INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`))
      .rows;
    await c.query(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      currentId,
      id,
    ]);
  };
  const refusal: Step = async (tx, c) => {
    const { rows } = await c.query(`SELECT "entityId" FROM "CommentV3" WHERE id = $1`, [currentId]);
    return refuseFpCommentIn(tx as never, currentId, rows[0]?.entityId ?? 0);
  };
  /**
   * A report filed through createReport on its own Prisma transaction, held open after it wrote
   * until released.
   */
  const filing = (userId: number) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: (pid: number) => void;
    const pid = new Promise<number>((r) => (started = r));
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    const settled = { done: false };
    const outcome = prisma
      .$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          started(row.pid);
          const report = await createReport({
            userId,
            isModerator: false,
            id: currentId,
            type: ReportEntity.CommentV3,
            reason: ReportReason.AdminAttention,
            details: { reason: 'Other', comment: 'reported' },
            tx,
          });
          wrote();
          await gate;
          return report;
        },
        { timeout: 30_000, maxWait: 10_000 }
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    void outcome.finally(() => (settled.done = true));
    return { pid, written, release, outcome, settled };
  };
  /** A pending csam hold, as the hold writer takes it: the hold lock only. */
  const hold: Step = async (tx, c) => {
    await lockCsamHold(tx as never, 'CommentV3', currentId);
    await c.query(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [currentId]
    );
  };
  let currentId = 0;

  describe('a clear never undoes a restriction', () => {
    const clears = { unhide: { hidden: false }, 'ToS clear': { tosViolation: false } } as const;
    const restricts = { hide: { hidden: true }, 'ToS removal': { tosViolation: true } } as const;
    const cases = Object.entries(clears).flatMap(([c, clear]) =>
      Object.entries(restricts).flatMap(([r, restrict]) => [
        [c, r, 'clear first', clear, restrict] as const,
        [c, r, 'restriction first', clear, restrict] as const,
      ])
    );
    it.each(cases)(
      '%s x %s, %s: still restricted, owed to the platform',
      async (_c, _r, order, clear, restrict) => {
        currentId = await seed();
        // An earlier restriction of each kind the clear could lift.
        await c0.query(
          `UPDATE "CommentV3" SET hidden = true, "tosViolation" = true WHERE id = $1`,
          [currentId]
        );
        if (order === 'clear first') await race(flags(clear), flags(restrict));
        else await race(flags(restrict), flags(clear));
        expect(await state(currentId)).toMatchObject({
          hidden: true,
          tosViolation: true,
          due: true,
        });
      }
    );
  });

  describe('restrictions union', () => {
    it.each([['hide then ToS'], ['ToS then hide']])('%s: both flags, owed once', async (order) => {
      currentId = await seed();
      const [a, b] =
        order === 'hide then ToS'
          ? [flags({ hidden: true }), flags({ tosViolation: true })]
          : [flags({ tosViolation: true }), flags({ hidden: true })];
      const r = await race(a, b);
      expect(r.waited).toBe(true);
      expect(await state(currentId)).toMatchObject({ hidden: true, tosViolation: true, due: true });
      expect(await restricted(currentId)).toBe(true);
    });
  });

  describe('the first removal decides how a comment went', () => {
    const writers = {
      'author delete': ['author', authorDelete],
      'moderator delete': ['moderator', gone('moderator')],
      refusal: ['refused', refusal],
    } as const;
    const pairs = Object.entries(writers).flatMap(([a, [cause, first]]) =>
      Object.entries(writers)
        .filter(([b]) => b !== a)
        .map(([b, [, second]]) => [a, b, cause, first, second] as const)
    );
    it.each(pairs)('%s, then %s: %s', async (_a, _b, cause, first, second) => {
      currentId = await seed();
      const r = await race(first, second);
      expect(r.waited).toBe(true);
      expect(await state(currentId)).toMatchObject({ goneCause: cause, due: true });
      expect(await restricted(currentId)).toBe(true);
    });
  });

  describe('a restriction and a removal', () => {
    const restricts = {
      hide: flags({ hidden: true }),
      'ToS removal': flags({ tosViolation: true }),
    } as const;
    const removals = {
      'moderator delete': ['moderator', gone('moderator')],
      refusal: ['refused', refusal],
    } as const;
    const cases = Object.entries(restricts).flatMap(([r, restrict]) =>
      Object.entries(removals).flatMap(([g, [cause, removal]]) => [
        [r, g, 'restriction first', cause, restrict, removal] as const,
        [r, g, 'removal first', cause, restrict, removal] as const,
      ])
    );
    it.each(cases)(
      '%s x %s, %s: removed as %s',
      async (_r, _g, order, cause, restrict, removal) => {
        currentId = await seed();
        if (order === 'restriction first') await race(restrict, removal);
        else await race(removal, restrict);
        expect(await state(currentId)).toMatchObject({ goneCause: cause, due: true });
      }
    );

    it.each([['restriction first'], ['delete first']])(
      'a hide x the author delete, %s: retracted',
      async (order) => {
        currentId = await seed();
        if (order === 'restriction first') await race(flags({ hidden: true }), authorDelete);
        else await race(authorDelete, flags({ hidden: true }));
        expect(await state(currentId)).toMatchObject({ goneCause: 'author', due: true });
      }
    );
  });

  // An author's delete never takes away text a ToS removal, a report or a csam hold has made
  // evidence: whichever commits first, the delete re-reads all three under the hold lock and the
  // row lock. Restriction first: refused, text kept. Delete first: retracted, the later writer
  // finds it gone.
  describe('evidence and the author delete', () => {
    const evidence = {
      'a ToS removal': flags({ tosViolation: true }),
      'a report': report,
      'a csam hold': hold,
    } as const;
    it.each(Object.entries(evidence))(
      '%s committed while the delete waits for its lock: refused, the text kept',
      async (_, write) => {
        currentId = await seed();
        const r = await race(write, authorDelete);
        expect(r.waited).toBe(true);
        expect(r.ok).toBe(false);
        expect(await state(currentId)).toMatchObject({
          present: true,
          deleted: false,
          content: '<p>evidence</p>',
          goneCause: null,
        });
      }
    );

    it.each(Object.entries(evidence))(
      'the delete committed first, then %s: retracted, and the later write finds it gone',
      async (name, write) => {
        currentId = await seed();
        const r = await race(authorDelete, write);
        expect(r.waited).toBe(true);
        expect(await state(currentId)).toMatchObject({ goneCause: 'author' });
        expect((await state(currentId)).present).toBe(false);
        // The report's link has no comment to point at once it is gone.
        if (name === 'a report') expect(r.ok).toBe(false);
      }
    );

    it("a report's link to the comment waits on the delete's row lock (key share against for update)", async () => {
      currentId = await seed();
      const free = await race(async () => undefined, report);
      expect(free.waited).toBe(false);
      currentId = await seed();
      const locked = await race(
        (_tx, c) => c.query(`SELECT 1 FROM "CommentV3" WHERE id = $1 FOR UPDATE`, [currentId]),
        report
      );
      expect(locked.waited).toBe(true);
    });

    it('a comment not yet scanned clear: refused with a retryable conflict, the text kept', async () => {
      currentId = await seed({ scanned: false });
      await c1.query('BEGIN');
      await expect(authorDelete(txOf(c1), c1)).rejects.toMatchObject({ code: 'CONFLICT' });
      await c1.query('ROLLBACK');
      expect(await state(currentId)).toMatchObject({ present: true, goneCause: null });
    });
  });

  // A Feature Pages comment's report is open or a new row, whoever files it, so the author delete,
  // which reads open reports under lock, never misses one.
  describe('a report on a Feature Pages comment, through createReport', () => {
    const reportRow = async (status: string, commentId = currentId) => {
      const [{ id }] = (
        await c0.query(
          `INSERT INTO "Report"(status, reason, "userId") VALUES ($1, 'AdminAttention', 9) RETURNING id`,
          [status]
        )
      ).rows;
      await c0.query(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
        commentId,
        id,
      ]);
      return id as number;
    };
    const reportsOf = async (commentId = currentId) =>
      (
        await c0.query(
          `SELECT r.status, r."alsoReportedBy" FROM "Report" r
           JOIN "CommentV3Report" cr ON cr."reportId" = r.id WHERE cr."commentId" = $1 ORDER BY r.id`,
          [commentId]
        )
      ).rows;
    const file = async (userId: number) => {
      const f = filing(userId);
      await f.written;
      f.release();
      const o = await f.outcome;
      if (!o.ok) throw o.error;
      return o.value;
    };
    const reopen =
      (id: () => number): Step =>
      (_tx, c) =>
        c.query(`UPDATE "Report" SET status = 'Pending' WHERE id = $1`, [id()]);

    it('files an open report, and folds the next reporter into it', async () => {
      currentId = await seed();
      await file(7);
      await file(8);
      expect(await reportsOf()).toEqual([{ status: 'Pending', alsoReportedBy: [8] }]);
    });

    it('after a dismissal, a report opens a new queue row and the author delete is refused', async () => {
      currentId = await seed();
      await reportRow('Unactioned');
      await file(7);
      expect(await reportsOf()).toEqual([
        { status: 'Unactioned', alsoReportedBy: [] },
        { status: 'Pending', alsoReportedBy: [] },
      ]);
      await c1.query('BEGIN');
      await expect(authorDelete(txOf(c1), c1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await c1.query('ROLLBACK');
    });

    it("any other comment's report still folds into a closed one", async () => {
      await c0.query(
        `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model', 1) ON CONFLICT DO NOTHING`
      );
      const [{ id }] = (
        await c0.query(
          `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content)
           VALUES ('model', 1, 2, '<p>x</p>') RETURNING id`
        )
      ).rows;
      currentId = id;
      await reportRow('Unactioned');
      await file(7);
      expect(await reportsOf()).toEqual([{ status: 'Unactioned', alsoReportedBy: [7] }]);
    });

    it('a dismissal committed while the fold waits: the report opens a new queue row', async () => {
      currentId = await seed();
      const id = await reportRow('Pending');
      await c1.query('BEGIN');
      await c1.query(`UPDATE "Report" SET status = 'Unactioned' WHERE id = $1`, [id]);
      const f = filing(7);
      expect(await waitingOrDone(await f.pid, f.settled)).toBe('waiting');
      await c1.query('COMMIT');
      await f.written;
      f.release();
      expect((await f.outcome).ok).toBe(true);
      expect(await reportsOf()).toEqual([
        { status: 'Unactioned', alsoReportedBy: [] },
        { status: 'Pending', alsoReportedBy: [] },
      ]);
    });

    it('a filed report committed while the author delete waits: refused, the text kept', async () => {
      currentId = await seed();
      const f = filing(7);
      await f.written;
      await c2.query('BEGIN');
      const settled = { done: false };
      const deleted = authorDelete(txOf(c2), c2).then(
        () => true,
        (e: { code?: string }) => e.code
      );
      void deleted.finally(() => (settled.done = true));
      expect(await waitingOrDone(c2, settled)).toBe('waiting');
      f.release();
      expect((await f.outcome).ok).toBe(true);
      expect(await deleted).toBe('FORBIDDEN');
      await c2.query('ROLLBACK');
      expect(await state(currentId)).toMatchObject({ present: true, goneCause: null });
    });

    it('the author delete committed first: the report waits, then finds nothing to report', async () => {
      currentId = await seed();
      await c1.query('BEGIN');
      await authorDelete(txOf(c1), c1);
      const f = filing(7);
      expect(await waitingOrDone(await f.pid, f.settled)).toBe('waiting');
      await c1.query('COMMIT');
      expect(await f.outcome).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await state(currentId)).toMatchObject({ goneCause: 'author' });
    });

    it.each([['the reopen first'], ['the delete first']])(
      "a moderator's reopen x the author delete, %s: one waits for the other",
      async (order) => {
        currentId = await seed();
        const id = await reportRow('Unactioned');
        const r =
          order === 'the reopen first'
            ? await race(
                reopen(() => id),
                authorDelete
              )
            : await race(
                authorDelete,
                reopen(() => id)
              );
        expect(r.waited).toBe(true);
        if (order === 'the reopen first') {
          expect(r.ok).toBe(false);
          expect(await state(currentId)).toMatchObject({ present: true, goneCause: null });
        } else expect(await state(currentId)).toMatchObject({ goneCause: 'author' });
      }
    );
  });

  // A dirty-pass mark read before a restriction landed never stops that restriction's alert clock.
  describe('a stale visible mark and a restriction', () => {
    const markers = {
      'a hide': (id: number) => setCommentFlags(runner(c0), [id], { hidden: true }),
      'a ToS removal': (id: number) => setCommentFlags(runner(c0), [id], { tosViolation: true }),
      'a moderator delete': (id: number) => deleteComments(runner(c0), [id], 'moderator'),
      'the author delete': async (id: number) => {
        await c0.query('BEGIN');
        await deleteOwnCommentV3(txOf(c0) as never, { id, entityType: 'featurePage' });
        await c0.query('COMMIT');
      },
    } as const;
    const cases = Object.entries(markers).flatMap(([name, mark]) => [
      [name, 'the restriction first', mark] as const,
      [name, 'the stale mark first', mark] as const,
    ]);
    it.each(cases)('%s, %s: still owed', async (_, order, mark) => {
      const id = await seed();
      const stale = () =>
        markFpMirrorDue(kysely, [{ commentId: id, pendingDigest: 'visible', restrict: false }]);
      if (order === 'the restriction first') {
        await mark(id);
        await stale();
      } else {
        await stale();
        await mark(id);
      }
      expect(await restricted(id)).toBe(true);
    });
  });

  // The edit's locked steps, as writeCommentEdit runs them: the hold lock, the row lock, the checks.
  const editStep: Step = async (tx, c) => {
    const hooks = fpEditHooks(currentId, `edit-${currentId}`);
    await hooks.beforeLock(tx as never);
    const current = await getStoredComment(runner(c), currentId, 'FOR UPDATE');
    if (!current) throw new Error('gone');
    await hooks.beforeUpdate(runner(c), current, tx as never);
    await c.query(`UPDATE "CommentV3" SET content = '<p>edited</p>' WHERE id = $1`, [currentId]);
  };
  /** A report through createReport and a writer, the report held open first or second. */
  const raceReport = async (order: 'the report first' | 'the writer first', step: Step) => {
    if (order === 'the report first') {
      const f = filing(7);
      await f.written;
      await c2.query('BEGIN');
      const settled = { done: false };
      const outcome = step(txOf(c2), c2).then(
        (value) => ({ ok: true as const, value }),
        (error: { code?: string }) => ({ ok: false as const, error })
      );
      void outcome.finally(() => (settled.done = true));
      const waited = (await waitingOrDone(c2, settled)) === 'waiting';
      f.release();
      expect((await f.outcome).ok).toBe(true);
      const r = await outcome;
      await c2.query(r.ok ? 'COMMIT' : 'ROLLBACK');
      return { waited, writer: r, report: { ok: true } };
    }
    await c1.query('BEGIN');
    const writer = await step(txOf(c1), c1).then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string }) => ({ ok: false as const, error })
    );
    const f = filing(7);
    const waited = (await waitingOrDone(await f.pid, f.settled)) === 'waiting';
    await c1.query(writer.ok ? 'COMMIT' : 'ROLLBACK');
    void f.written.then(() => f.release());
    const report = await f.outcome;
    return { waited, writer, report };
  };
  const contentOf = async () =>
    (
      await c0.query(
        `SELECT content, hidden, "deletedAt" IS NOT NULL AS deleted FROM "CommentV3" WHERE id = $1`,
        [currentId]
      )
    ).rows[0];

  describe('the edit, the refusal and the scan hide against the other writers', () => {
    it.each([['the ToS removal first'], ['the edit first']])(
      'an edit x a ToS removal, %s: one waits, and no edit lands under the removal',
      async (order) => {
        currentId = await seed();
        const r =
          order === 'the ToS removal first'
            ? await race(flags({ tosViolation: true }), editStep)
            : await race(editStep, flags({ tosViolation: true }));
        expect(r.waited).toBe(true);
        if (order === 'the ToS removal first') {
          expect(r.ok).toBe(false);
          expect(await contentOf()).toMatchObject({ content: '<p>evidence</p>' });
        }
        expect(await state(currentId)).toMatchObject({ tosViolation: true });
      }
    );

    it.each([['the hold first'], ['the edit first']])(
      'an edit x a csam hold, %s: one waits, and no edit lands under the hold',
      async (order) => {
        currentId = await seed();
        const r =
          order === 'the hold first' ? await race(hold, editStep) : await race(editStep, hold);
        expect(r.waited).toBe(true);
        if (order === 'the hold first') {
          expect(r.ok).toBe(false);
          expect(await contentOf()).toMatchObject({ content: '<p>evidence</p>' });
        }
      }
    );

    it.each([['the report first'], ['the writer first']] as const)(
      'an edit x a report through createReport, %s: one waits, and no edit lands under the report',
      async (order) => {
        currentId = await seed();
        const r = await raceReport(order, editStep);
        expect(r.waited).toBe(true);
        expect(r.report.ok).toBe(true);
        if (order === 'the report first') {
          expect(r.writer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
          expect(await contentOf()).toMatchObject({ content: '<p>evidence</p>' });
        }
      }
    );

    it.each([['the report first'], ['the writer first']] as const)(
      'a refusal x a report through createReport, %s: reported, it is kept hidden; refused first, the report finds it gone',
      async (order) => {
        currentId = await seed();
        const r = await raceReport(order, refusal);
        expect(r.waited).toBe(true);
        if (order === 'the report first')
          expect(await contentOf()).toMatchObject({ hidden: true, deleted: false });
        else expect(r.report).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(await state(currentId)).toMatchObject({ goneCause: 'refused' });
      }
    );

    it.each([
      ['the author delete', authorDelete],
      ['an edit', editStep],
    ] as const)(
      '%s while a report folds into the open one: it waits for the fold and is refused',
      async (_, step) => {
        currentId = await seed();
        await c0
          .query(
            `INSERT INTO "Report"(status, reason, "userId") VALUES ('Pending', 'AdminAttention', 9) RETURNING id`
          )
          .then(({ rows }) =>
            c0.query(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
              currentId,
              rows[0].id,
            ])
          );
        const r = await raceReport('the report first', step);
        expect(r.waited).toBe(true);
        expect(r.writer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
        expect(await contentOf()).toMatchObject({ content: '<p>evidence</p>', deleted: false });
      }
    );

    it.each([['the reopen first'], ['the edit first']])(
      "an edit x a moderator's reopen, %s: one waits for the other",
      async (order) => {
        currentId = await seed();
        const [{ id }] = (
          await c0.query(
            `INSERT INTO "Report"(status, reason, "userId") VALUES ('Unactioned', 'AdminAttention', 9) RETURNING id`
          )
        ).rows;
        await c0.query(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
          currentId,
          id,
        ]);
        const reopen: Step = (_tx, c) =>
          c.query(`UPDATE "Report" SET status = 'Pending' WHERE id = $1`, [id]);
        const r =
          order === 'the reopen first'
            ? await race(reopen, editStep)
            : await race(editStep, reopen);
        expect(r.waited).toBe(true);
        if (order === 'the reopen first') {
          expect(r.ok).toBe(false);
          expect(await contentOf()).toMatchObject({ content: '<p>evidence</p>' });
        }
      }
    );

    it('a scan finding: the author delete between its report and its hide is refused', async () => {
      currentId = await seed();
      const deleteAttempts: unknown[] = [];
      await hideFlaggedFpComment(currentId, {
        db: {
          $queryRawUnsafe: txOf(c0).$queryRawUnsafe,
          $transaction: async (fn: (tx: never) => Promise<unknown>) => {
            // The author's delete as the hide starts: the report must already be committed.
            await c1.query('BEGIN');
            deleteAttempts.push(
              await authorDelete(txOf(c1), c1).then(
                () => 'deleted',
                (e: { code?: string }) => e.code
              )
            );
            await c1.query('ROLLBACK');
            await c2.query('BEGIN');
            try {
              const value = await fn(txOf(c2) as never);
              await c2.query('COMMIT');
              return value;
            } catch (e) {
              await c2.query('ROLLBACK');
              throw e;
            }
          },
        } as never,
        createReport: async (input) => {
          return prisma.$transaction((tx) =>
            createReport({ ...(input as Parameters<typeof createReport>[0]), tx })
          );
        },
      });
      expect(deleteAttempts).toEqual(['FORBIDDEN']);
      expect(await state(currentId)).toMatchObject({
        hidden: true,
        present: true,
        goneCause: null,
      });
    });
  });

  describe('batch row locks', () => {
    /** Two comments whose heap order is the reverse of their id order. */
    const reversedPair = async (prepare?: (ids: number[]) => Promise<unknown>) => {
      const a = await seed();
      const b = await seed();
      await prepare?.([a, b]);
      // Last, so nothing moves b after it.
      await c0.query(`UPDATE "CommentV3" SET content = content WHERE id = $1`, [a]);
      return [a, b] as const;
    };
    /** Runs `write` on c2 with index scans off while c1 holds a; returns whether b was still free. */
    const higherFreeWhileWaiting = async (a: number, b: number, write: () => Promise<unknown>) => {
      await c1.query('BEGIN');
      await c1.query(`SELECT 1 FROM "CommentV3" WHERE id = $1 FOR UPDATE`, [a]);
      await c2.query('BEGIN');
      await c2.query('SET LOCAL enable_indexscan = off');
      await c2.query('SET LOCAL enable_bitmapscan = off');
      const settled = { done: false };
      const run = write().finally(() => (settled.done = true));
      expect(await waitingOrDone(c2, settled)).toBe('waiting');
      const free = await c0.query(
        `SELECT id FROM "CommentV3" WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [b]
      );
      await c1.query('COMMIT');
      await run;
      await c2.query('ROLLBACK');
      return free.rows.length === 1;
    };

    it('a flag write locks its rows in id order: waiting on a lower id, it holds no higher one', async () => {
      const [a, b] = await reversedPair();
      expect(
        await higherFreeWhileWaiting(a, b, () =>
          setCommentFlags(runner(c2), [b, a], { tosViolation: true })
        )
      ).toBe(true);
    });

    it('the scam restore locks its rows in id order: waiting on a lower id, it holds no higher one', async () => {
      const at = new Date();
      const [a, b] = await reversedPair((ids) =>
        c0.query(`UPDATE "CommentV3" SET hidden = true, "hiddenAt" = $2 WHERE id = ANY($1)`, [
          ids,
          at,
        ])
      );
      expect(
        await higherFreeWhileWaiting(a, b, () => restoreCommentsIn(runner(c2), 2, [b, a], at))
      ).toBe(true);
    });

    it('the ToS clear locks its rows in id order: waiting on a lower id, it holds no higher one', async () => {
      const a = await seed();
      const b = await seed();
      await c0.query(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = ANY($1)`, [[a, b]]);
      // a's row moves past b's in the heap, so a scan in heap order meets b first.
      await c0.query(`UPDATE "CommentV3" SET content = content WHERE id = $1`, [a]);
      await c1.query('BEGIN');
      await c1.query(`SELECT 1 FROM "CommentV3" WHERE id = $1 FOR UPDATE`, [a]);
      await c2.query('BEGIN');
      await c2.query('SET LOCAL enable_indexscan = off');
      await c2.query('SET LOCAL enable_bitmapscan = off');
      const settled = { done: false };
      const clear = clearCommentV3TosViolationIn(txOf(c2) as never, [b, a]).finally(
        () => (settled.done = true)
      );
      expect(await waitingOrDone(c2, settled)).toBe('waiting');
      const higherFree = await c0.query(
        `SELECT id FROM "CommentV3" WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [b]
      );
      await c1.query('COMMIT');
      await clear;
      await c2.query('ROLLBACK');
      expect(higherFree.rows).toHaveLength(1);
    });
  });

  describe('delivery bookkeeping', () => {
    const facts = async (id: number) => (await readFpMirrorFacts(kysely, [id]))[0];

    it.each([
      ['a hide', (id: number) => setCommentFlags(runner(c0), [id], { hidden: true })],
      ['a moderator delete', (id: number) => deleteComments(runner(c0), [id], 'moderator')],
      [
        'the dirty pass',
        (id: number) =>
          markFpMirrorDue(kysely, [{ commentId: id, pendingDigest: 'x', restrict: true }]),
      ],
    ] as const)(
      '%s during a send: the push is recorded and the row is due again',
      async (_, write) => {
        const id = await seed();
        await c0.query(
          `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = $1`,
          [id]
        );
        const read = await facts(id);
        await write(id);
        await recordFpPush(kysely, id, {
          readAt: read.mirrorUpdatedAt,
          pushedState: 'visible',
          nextPushAt: null,
          pushAttempts: 0,
        });
        expect(await state(id)).toMatchObject({ due: true });
      }
    );

    it('the dirty pass clearing an owed restriction alone: the clock and its want both stop', async () => {
      const id = await seed();
      await markFpMirrorDue(kysely, [{ commentId: id, pendingDigest: 'hidden', restrict: true }]);
      const read = await facts(id);
      await clearFpRestricted(kysely, [{ commentId: id, readAt: read.mirrorUpdatedAt }]);
      expect(await facts(id)).toMatchObject({ restrictedAt: null, pendingDigest: null });
    });

    it('a push that gives up and parks stops the alert clock; the stuck count has it', async () => {
      const id = await seed();
      await c0.query(
        `UPDATE "FeaturePageCommentMirror" SET "restrictedAt" = now() WHERE "commentId" = $1`,
        [id]
      );
      await recordFpPush(kysely, id, { nextPushAt: null, pushAttempts: 8, parked: true });
      expect(await restricted(id)).toBe(false);
    });

    it.each([['the restriction first'], ['the clear first']])(
      'the dirty pass clearing an owed restriction x a new one, %s: still owed',
      async (order) => {
        const id = await seed();
        await c0.query(
          `UPDATE "FeaturePageCommentMirror" SET "restrictedAt" = now() WHERE "commentId" = $1`,
          [id]
        );
        const read = await facts(id);
        if (order === 'the restriction first') {
          await setCommentFlags(runner(c0), [id], { hidden: true });
          await clearFpRestricted(kysely, [{ commentId: id, readAt: read.mirrorUpdatedAt }]);
        } else {
          await clearFpRestricted(kysely, [{ commentId: id, readAt: read.mirrorUpdatedAt }]);
          await setCommentFlags(runner(c0), [id], { hidden: true });
        }
        expect(await restricted(id)).toBe(true);
      }
    );

    it('a reconcile leaves a row already scheduled alone', async () => {
      const id = await seed();
      await c0.query(
        `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() + interval '5 minutes', "pushAttempts" = 3,
           "pushedDigest" = 'pushed' WHERE "commentId" = $1`,
        [id]
      );
      await markFpReconciled(kysely, id, 'repost');
      const { rows } = await c0.query(
        `SELECT "pushAttempts", "pushedDigest" FROM "FeaturePageCommentMirror" WHERE "commentId" = $1`,
        [id]
      );
      expect(rows[0]).toEqual({ pushAttempts: 3, pushedDigest: 'pushed' });
    });

    it('owed restrictions lease first, ahead of older visible pushes, and come back first', async () => {
      const older: number[] = [];
      for (let i = 0; i < 5; i++) older.push(await seed());
      const hidden = await seed();
      await c0.query(
        `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() - interval '1 hour' WHERE "commentId" = ANY($1)`,
        [older]
      );
      await setCommentFlags(runner(c0), [hidden], { hidden: true });
      const leased = await leaseFpMirrorRows(kysely, 3);
      expect(leased[0]).toBe(hidden);
      expect(leased).toHaveLength(3);
    });

    it('two runs never lease the same row', async () => {
      for (let i = 0; i < 6; i++) await seed();
      await c0.query(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now()`);
      const [a, b] = await Promise.all([
        leaseFpMirrorRows(kysely, 4),
        leaseFpMirrorRows(kysely, 4),
      ]);
      expect(a.filter((id) => b.includes(id))).toEqual([]);
      expect(a.length + b.length).toBe(6);
    });
  });
});
