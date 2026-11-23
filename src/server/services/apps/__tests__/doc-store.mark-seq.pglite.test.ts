import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  createDocStoreModeration,
  createDocStoreRater,
  type DocStore,
  type DocStoreModeration,
  type DocStoreRater,
} from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  MIGRATION_MARK_HEAD_DOWN,
  MIGRATION_MARK_HEAD_UP,
  type Harness,
} from './doc-store.harness';
import {
  BOARD,
  ctx,
  expectCode,
  freshApp,
  NS_DEV,
  NS_PROD,
  POSTS,
  TALLIES,
  VIEWER_1,
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The MARK SEQUENCE (`apps/app-data-go/WRITES-DESIGN.md`, "Marks get their own sequence"): one
 * counter per (app, namespace) in `appdata.mark_head`, taken by every mark, unmark and increment
 * under lock (1c) and stamped on the tally row it changed, on the shipped migration, as
 * `appdata_rw`. What is stamped is read back by the superuser with this file's own SQL; every
 * sequence is a literal (a fresh namespace numbers its marks 1, 2, 3, …). And what it must NOT
 * move: `doc.seq`, which moderation's `ifRevision` and the rater's binding check.
 */

const MOD = 9_301;

describe.each([{ rls: true }, { rls: false }])('the mark sequence (rls %o)', (opts) => {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await createPgliteHarness(opts);
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  const head = async (app: string, ns = NS_PROD) => {
    const rows = await h.raw(
      `SELECT mh.last_mark_seq FROM appdata.mark_head mh WHERE mh.app_id = $1 AND mh.ns = $2`,
      [app, ns]
    );
    return rows.length === 0 ? null : Number(rows[0].last_mark_seq);
  };
  const tallies = async (app: string) =>
    (
      await h.raw(
        `SELECT t.coll, t.key, t.kind, t.name, t.count::int AS count, t.mark_seq::int AS mark_seq
           FROM appdata.doc_tally t WHERE t.app_id = $1 ORDER BY t.coll, t.key, t.kind, t.name`,
        [app]
      )
    ).map((r) => [r.coll, r.key, r.kind, r.name, r.count, r.mark_seq]);
  const marks = async (app: string) =>
    (
      await h.raw(
        `SELECT mk.key, mk.name, mk.user_id
           FROM appdata.doc_mark mk WHERE mk.app_id = $1 ORDER BY mk.key, mk.name, mk.user_id`,
        [app]
      )
    ).map((r) => [r.key, r.name, r.user_id]);

  it('mark, unmark and increment each take the next sequence and stamp the rows they changed', async () => {
    const app = freshApp('MSEQ');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    const v2 = ctx(app, NS_PROD, VIEWER_2);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect(await head(app)).toBeNull();

    expect((await store.mark(v1, POSTS, 'p', 'vote')).markSeq).toBe(1);
    expect((await store.mark(v2, POSTS, 'p', 'vote')).markSeq).toBe(2);
    expect((await store.increment(v2, POSTS, 'p', 'views', 6)).markSeq).toBe(3);
    expect((await store.unmark(v1, POSTS, 'p', 'vote')).markSeq).toBe(4);
    expect(await head(app)).toBe(4);
    // The tally rows carry the sequence of their last change; the vote row v1 withdrew is gone.
    expect(await tallies(app)).toEqual([
      ['posts', 'p', 'counter', 'views', 6, 3],
      ['posts', 'p', 'mark', 'vote', 1, 4],
    ]);
    expect(await marks(app)).toEqual([['p', 'vote', VIEWER_2]]);
  });

  it('a mark or unmark that changes nothing still takes a sequence, and stamps nothing', async () => {
    const app = freshApp('MSEQNOOP');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    await store.mark(v1, POSTS, 'p', 'star');
    expect(await store.mark(v1, POSTS, 'p', 'star')).toEqual({
      marked: true,
      count: 1,
      markSeq: 2,
    });
    expect(await store.unmark(v1, POSTS, 'p', 'vote')).toEqual({
      marked: false,
      count: 0,
      markSeq: 3,
    });
    expect(await tallies(app)).toEqual([['posts', 'p', 'mark', 'star', 1, 1]]);
    expect(await marks(app)).toEqual([['p', 'star', VIEWER_1]]);
    expect(await head(app)).toBe(3);
  });

  it('a report takes a sequence like any mark; its count stays hidden', async () => {
    const app = freshApp('MSEQREP');
    await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
    expect(await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p', 'report')).toEqual({
      marked: true,
      count: null,
      markSeq: 1,
    });
    expect(await marks(app)).toEqual([['p', 'report', VIEWER_2]]);
  });

  it('one counter for every collection of the app; another namespace and another app count on their own', async () => {
    const app = freshApp('MSEQALL');
    const other = freshApp('MSEQOTHER');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect((await store.mark(v1, POSTS, 'p', 'vote')).markSeq).toBe(1);
    expect((await store.increment(v1, TALLIES, 'song', 'plays')).markSeq).toBe(2);
    expect((await store.increment(v1, POSTS, 'p', 'views')).markSeq).toBe(3);
    const dev = ctx(app, NS_DEV, VIEWER_1);
    await store.put(dev, POSTS, 'p', { status: 'open' });
    expect((await store.mark(dev, POSTS, 'p', 'vote')).markSeq).toBe(1);
    await store.put(ctx(other, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
    expect((await store.mark(ctx(other, NS_PROD, VIEWER_1), POSTS, 'p', 'vote')).markSeq).toBe(1);
    expect([await head(app), await head(app, NS_DEV), await head(other)]).toEqual([3, 1, 1]);
  });

  it('an increment that creates its counter document answers that document’s seq beside its mark sequence', async () => {
    const app = freshApp('MSEQCREATE');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await store.put(v1, BOARD, 'b', { t: 'one' });
    expect(await store.increment(v1, TALLIES, 'song', 'plays', 2)).toEqual({
      value: 2,
      markSeq: 1,
      seq: 2,
    });
    expect(await store.increment(v1, TALLIES, 'song', 'plays')).toEqual({ value: 3, markSeq: 2 });
    expect(await tallies(app)).toEqual([['tallies', 'song', 'counter', 'plays', 3, 2]]);
  });

  it('a refused mark takes no sequence', async () => {
    const app = freshApp('MSEQREFUSED');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await expectCode(store.mark(v1, POSTS, 'absent', 'vote'), 'not_found');
    await expectCode(store.mark(v1, POSTS, 'absent', 'undeclared'), 'invalid_request');
    expect(await head(app)).toBeNull();
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect((await store.mark(v1, POSTS, 'p', 'vote')).markSeq).toBe(1);
  });

  describe('🔴 the lock order: (1) document, (1b) tally and mark rows, (1c) mark_head, (2) usage_app, (3) usage_user', () => {
    /** The tables, in order, of the statements one call sent for `app`. */
    async function tablesOf(app: string, call: () => Promise<unknown>): Promise<string[]> {
      const from = h.statements.length;
      await call();
      return h.statements
        .slice(from)
        .filter((s) => s.app === app)
        .map((s) => /appdata\.([a-z_]+)/.exec(s.sql)?.[1] ?? '?');
    }

    it('a mark, an unmark and an increment of an existing document: (1b), then (1c), then the stamps; no usage lock', async () => {
      const app = freshApp('MSEQLOCK');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, POSTS, 'p', { status: 'open' });
      expect(await tablesOf(app, () => store.mark(v1, POSTS, 'p', 'vote'))).toEqual([
        'doc',
        'doc_mark',
        'doc_tally',
        'mark_head',
        'doc_tally',
      ]);
      expect(await tablesOf(app, () => store.unmark(v1, POSTS, 'p', 'vote'))).toEqual([
        'doc',
        'doc_mark',
        'doc_tally',
        'mark_head',
        'doc_tally',
      ]);
      expect(await tablesOf(app, () => store.increment(v1, POSTS, 'p', 'views'))).toEqual([
        'doc',
        'doc_tally',
        'mark_head',
        'doc_tally',
      ]);
    });

    it('an increment that creates its counter document takes (1c) before (2) and (3)', async () => {
      const app = freshApp('MSEQLOCKNEW');
      const tables = await tablesOf(app, () =>
        store.increment(ctx(app, NS_PROD, VIEWER_1), TALLIES, 'song', 'plays')
      );
      const at = (t: string) => tables.indexOf(t);
      expect(tables.filter((t) => t === 'mark_head')).toHaveLength(1);
      expect(at('doc_tally')).toBeGreaterThan(-1);
      expect(at('doc_tally')).toBeLessThan(at('mark_head'));
      expect(at('mark_head')).toBeLessThan(at('usage_app'));
      expect(at('usage_app')).toBeLessThan(at('usage_user'));
    });

    it('a document write never takes (1c): put, create and delete', async () => {
      const app = freshApp('MSEQDOC');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, POSTS, 'p', { status: 'open' });
      await store.mark(v1, POSTS, 'p', 'vote');
      const sent = [
        ...(await tablesOf(app, () => store.put(v1, POSTS, 'p', { status: 'edited' }))),
        ...(await tablesOf(app, () => store.create(v1, BOARD, { t: 'x' }))),
        ...(await tablesOf(app, () => store.delete(v1, POSTS, 'p'))),
      ];
      // Positive control: the calls were recorded (each charged usage_app).
      expect(sent.filter((t) => t === 'usage_app')).toHaveLength(3);
      expect(sent).not.toContain('mark_head');
      expect(await head(app)).toBe(1);
    });
  });
});

// INVARIANT GUARDS (green before the mark sequence existed; they pin that it moved nothing else):
// a vote changes neither a document's `seq` nor the revision moderation and the rater are bound to.
describe('a mark never moves the document’s seq: moderation and the rater still apply', () => {
  let h: Harness;
  let store: DocStore;
  let mod: DocStoreModeration;
  let rater: DocStoreRater;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true, docLevels: true, docRatingId: true });
    store = createDocStore({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
    rater = createDocStoreRater({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  const docSeq = async (app: string, key: string) =>
    Number(
      (
        await h.raw(
          `SELECT d.seq FROM appdata.doc d
            WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = 'posts' AND d.key = $3`,
          [app, NS_PROD, key]
        )
      )[0].seq
    );
  const appHead = async (app: string) =>
    Number(
      (
        await h.raw(
          `SELECT u.last_seq FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2`,
          [app, NS_PROD]
        )
      )[0].last_seq
    );

  it('mark, unmark and an increment of an existing document leave doc.seq and usage_app.last_seq as they were', async () => {
    const app = freshApp('MSEQDOCSEQ');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    const v2 = ctx(app, NS_PROD, VIEWER_2);
    await store.put(v1, POSTS, 'other', { status: 'x' });
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect([await docSeq(app, 'p'), await appHead(app)]).toEqual([2, 2]);
    await store.mark(v2, POSTS, 'p', 'vote');
    await store.increment(v2, POSTS, 'p', 'views', 4);
    await store.unmark(v2, POSTS, 'p', 'vote');
    await store.mark(v2, POSTS, 'p', 'report');
    expect([await docSeq(app, 'p'), await appHead(app)]).toEqual([2, 2]);
  });

  it("a moderator's hide bound to the pre-vote revision still applies after a vote", async () => {
    const app = freshApp('MSEQMOD');
    await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
    const seen = (await mod.get(app, NS_PROD, 'posts', 'p'))!.revision;
    await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p', 'vote');
    await store.increment(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p', 'views');
    expect(
      await mod.setHidden(app, NS_PROD, 'posts', 'p', true, MOD, { ifRevision: seen })
    ).toMatchObject({ changed: true });
    // Positive control: a write since the moderator looked IS refused.
    const later = freshApp('MSEQMODCTL');
    await store.put(ctx(later, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
    const before = (await mod.get(later, NS_PROD, 'posts', 'p'))!.revision;
    await store.put(ctx(later, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'edited' });
    await expectCode(
      mod.setHidden(later, NS_PROD, 'posts', 'p', true, MOD, { ifRevision: before }),
      'version_conflict'
    );
  });

  it('a rating of the revision the rater read still applies after a vote', async () => {
    const app = freshApp('MSEQRATE');
    await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
    const [read] = await rater.listUnrated(app, NS_PROD, 'posts', { afterSeq: 0, limit: 10 });
    expect(read.key).toBe('p');
    await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p', 'vote');
    await store.unmark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p', 'vote');
    expect(
      await rater.applyRating(app, NS_PROD, 'posts', 'p', { seq: read.seq, level: 4 })
    ).toMatchObject({ applied: true });
  });
});

describe('the shipped migration (applied by hand, so it must re-run and roll back cleanly)', () => {
  it('applies twice, rolls back twice and re-applies; the new table is granted to the store role', async () => {
    const h = await createPgliteHarness({ rls: true, markHead: false });
    try {
      const up = readFileSync(MIGRATION_MARK_HEAD_UP, 'utf8');
      const down = readFileSync(MIGRATION_MARK_HEAD_DOWN, 'utf8');
      const state = async () => ({
        table: (
          await h.raw(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_tables
              WHERE schemaname = 'appdata' AND tablename = 'mark_head'`
          )
        )[0].n,
        columns: (
          await h.raw(
            `SELECT c.table_name FROM information_schema.columns c
              WHERE c.table_schema = 'appdata' AND c.column_name = 'mark_seq' ORDER BY 1`
          )
        ).map((r) => r.table_name),
      });
      expect(await state()).toEqual({ table: 0, columns: [] });
      await h.raw(up);
      await h.raw(
        `INSERT INTO appdata.mark_head (app_id, ns, last_mark_seq) VALUES ('ab_MIG', 'prod', 7)`
      );
      await h.raw(up);
      expect(await state()).toEqual({ table: 1, columns: ['doc_tally'] });
      // Re-applying keeps the counter.
      expect(await h.raw(`SELECT last_mark_seq::int AS n FROM appdata.mark_head`)).toEqual([
        { n: 7 },
      ]);
      expect(
        (
          await h.raw(
            `SELECT g.privilege_type FROM information_schema.role_table_grants g
              WHERE g.grantee = 'appdata_rw' AND g.table_schema = 'appdata'
                AND g.table_name = 'mark_head' ORDER BY 1`
          )
        ).map((r) => r.privilege_type)
      ).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      await h.raw(down);
      await h.raw(down);
      expect(await state()).toEqual({ table: 0, columns: [] });
      await h.raw(up);
      expect(await state()).toEqual({ table: 1, columns: ['doc_tally'] });
    } finally {
      await h.close();
    }
  });
});

describe('🔴 before the migration is applied: marks, unmarks and increments work and answer no sequence', () => {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true, markHead: false });
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  it('every one succeeds exactly as before, with no markSeq; a creating increment still answers its seq', async () => {
    const app = freshApp('MSEQABSENT');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    const v2 = ctx(app, NS_PROD, VIEWER_2);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect(await store.mark(v2, POSTS, 'p', 'vote')).toEqual({ marked: true, count: 1 });
    expect(await store.mark(v2, POSTS, 'p', 'vote')).toEqual({ marked: true, count: 1 });
    expect(await store.mark(v1, POSTS, 'p', 'report')).toEqual({ marked: true, count: null });
    expect(await store.increment(v2, POSTS, 'p', 'views', 3)).toEqual({ value: 3 });
    expect(await store.unmark(v2, POSTS, 'p', 'vote')).toEqual({ marked: false, count: 0 });
    expect(await store.increment(v1, TALLIES, 'song', 'plays')).toEqual({ value: 1, seq: 2 });
    // The counts and marks are stored as they always were.
    expect((await store.get(v2, POSTS, 'p'))?.counters).toEqual({ vote: 0, views: 3 });
    expect(
      (
        await h.raw(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE tablename = $1`, [
          'mark_head',
        ])
      )[0].n
    ).toBe(0);
  });

  it('an app purge (the namespace wipe) still runs without the table', async () => {
    const app = freshApp('MSEQABSENTPURGE');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    await store.mark(v1, POSTS, 'p', 'vote');
    const out = await createDocStoreMaintenance({ db: h.db }).purgeApp(app);
    expect(out).toMatchObject({ done: true, stopped: false });
    expect(
      (await h.raw(`SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1`, [app]))[0].n
    ).toBe(0);
  });

  // Last in this block: it applies the migration.
  it('once the migration is applied, a running store takes the sequence after its recheck, with no restart', async () => {
    const app = freshApp('MSEQLATE');
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    await store.put(v1, POSTS, 'p', { status: 'open' });
    expect(await store.mark(v1, POSTS, 'p', 'vote')).toEqual({ marked: true, count: 1 });
    await h.raw(readFileSync(MIGRATION_MARK_HEAD_UP, 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Inside the recheck window it still answers from what it found: absent.
      expect(await store.mark(v1, POSTS, 'p', 'star')).toEqual({ marked: true, count: 1 });
      vi.setSystemTime(Date.now() + 61_000);
      expect(await store.unmark(v1, POSTS, 'p', 'star')).toEqual({
        marked: false,
        count: 0,
        markSeq: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
