import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore, createDocStoreModeration } from '~/server/services/apps/doc-store';
import type { DocStore, DocStoreModeration } from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { createPgliteHarness } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import {
  assertUsageConsistent,
  BOARD,
  ctx,
  expectCode,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
  VIEWER_1,
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The document store's MODERATOR operations (`mod.*`) on the embedded Postgres,
 * as the least-privilege role, twice: with RLS disabled on the tables (the module's own
 * `$1`/`$2` predicates alone) and with it on (both layers). Every effect is checked through
 * the REAL viewer reads, and usage against a recompute from the documents.
 *
 * Expected values are literals chosen by hand; ids are pairwise distinct and distinct from
 * every count the assertions name.
 */

const MOD = 9001;
const R1 = 3101;
const R2 = 3202;
const R3 = 3303;
const R4 = 3404;

const harnesses: Harness[] = [];

/** `{"score": 5, "status": "open"}` — the jsonb text of `{ status: 'open', score: 5 }`. */
const OPEN5_BYTES = Buffer.byteLength('{"score": 5, "status": "open"}', 'utf8');

function defineModerationSuite(rls: boolean) {
  let h: Harness;
  let store: DocStore;
  let mod: DocStoreModeration;
  beforeAll(async () => {
    h = await createPgliteHarness({ rls });
    harnesses.push(h);
    store = createDocStore({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
  });
  afterAll(async () => {
    await h?.close();
  });

  const report = async (app: string, coll: DocCollection, key: string, ...users: number[]) => {
    for (const u of users) await store.mark(ctx(app, NS_PROD, u), coll, key, 'report');
  };
  const queue = async (
    app: string,
    opts: Partial<Parameters<DocStoreModeration['listReported']>[2]> = {}
  ) =>
    (await mod.listReported(app, NS_PROD, { status: 'all', limit: 50, ...opts })).map(
      (r) => `${r.collection}/${r.key}:${r.reports}`
    );

  /**
   * Seed: five reported shared docs with report counts 3, 1, 2, 2, 2; two unreported. Among the three with 2 reports, `board/b1` was updated last (so it
   * comes first although `board` < `posts`), and `posts/p6` / `posts/p3` share an update time
   * (so only the key orders them).
   */
  async function seedQueue(app: string) {
    const v1 = ctx(app, NS_PROD, VIEWER_1);
    for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
      await store.put(v1, POSTS, k, { status: 'open' });
    await store.put(v1, BOARD, 'b1', { text: 'hi' });
    await report(app, POSTS, 'p1', R1, R2, R3);
    await report(app, POSTS, 'p2', R1);
    await report(app, POSTS, 'p3', R2, R3);
    await report(app, POSTS, 'p6', R1, R3);
    await report(app, BOARD, 'b1', R1, R3);
    await h.raw(`UPDATE appdata.doc SET updated_at = '2026-02-01T00:00:00Z' WHERE app_id = $1`, [
      app,
    ]);
    await h.raw(
      `UPDATE appdata.doc SET updated_at = '2026-02-05T00:00:00Z' WHERE app_id = $1 AND key = 'b1'`,
      [app]
    );
  }

  describe('report queue (one app)', () => {
    it('lists only reported shared docs: most reports, then latest update, then collection and key', async () => {
      const app = freshApp('modq');
      await seedQueue(app);
      expect(await queue(app)).toEqual([
        'posts/p1:3',
        'board/b1:2',
        'posts/p6:2',
        'posts/p3:2',
        'posts/p2:1',
      ]);
    });

    it('stops at the limit, keeping the head of the order', async () => {
      const app = freshApp('modlim');
      await seedQueue(app);
      expect(await queue(app, { limit: 3 })).toEqual(['posts/p1:3', 'board/b1:2', 'posts/p6:2']);
      await expectCode(
        mod.listReported(app, NS_PROD, { status: 'all', limit: 0 }),
        'invalid_request'
      );
    });

    it('carries the author, timestamps, revision and hidden state for moderators', async () => {
      const app = freshApp('modrow');
      await seedQueue(app);
      const [top] = await mod.listReported(app, NS_PROD, { status: 'all', limit: 1 });
      expect(top).toMatchObject({
        collection: 'posts',
        key: 'p1',
        reports: 3,
        authorKind: 'user',
        authorUid: VIEWER_1,
        hiddenAt: null,
        hiddenBy: null,
        updatedAt: new Date('2026-02-01T00:00:00Z'),
        revision: (await mod.get(app, NS_PROD, 'posts', 'p1'))!.revision,
      });
    });

    it('status filters open / hidden / all', async () => {
      const app = freshApp('modstat');
      await seedQueue(app);
      await mod.setHidden(app, NS_PROD, 'posts', 'p1', true, MOD);
      expect(await queue(app, { status: 'open' })).toEqual([
        'board/b1:2',
        'posts/p6:2',
        'posts/p3:2',
        'posts/p2:1',
      ]);
      expect(await queue(app, { status: 'hidden' })).toEqual(['posts/p1:3']);
      expect(await queue(app, { status: 'all' })).toHaveLength(5);
      const [hidden] = await mod.listReported(app, NS_PROD, {
        status: 'hidden',
        limit: 5,
      });
      expect(hidden.hiddenBy).toBe(MOD);
      expect(hidden.hiddenAt).toBeInstanceOf(Date);
    });
  });

  describe('review namespaces', () => {
    it('every moderator operation refuses a rev: namespace cleanly (invalid_request), touching nothing', async () => {
      const app = freshApp('modrev');
      const rev = 'rev:pubreq_MODREV:9001';
      await expectCode(mod.listReported(app, rev, { status: 'all', limit: 5 }), 'invalid_request');
      await expectCode(mod.get(app, rev, 'posts', 'k'), 'invalid_request');
      await expectCode(mod.setHidden(app, rev, 'posts', 'k', true, MOD), 'invalid_request');
      await expectCode(mod.dismissReports(app, rev, 'posts', 'k'), 'invalid_request');
      await expectCode(mod.delete(app, rev, 'posts', 'k'), 'invalid_request');
    });
  });

  describe('get', () => {
    it('returns a shared doc with its data, every tally including reports, hidden or not', async () => {
      const app = freshApp('modget');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, POSTS, 'g', { status: 'open', score: 5 });
      await store.increment(ctx(app, NS_PROD, VIEWER_2), POSTS, 'g', 'views', 7);
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'g', 'star');
      await report(app, POSTS, 'g', R1, R2);
      await mod.setHidden(app, NS_PROD, 'posts', 'g', true, MOD);
      const doc = await mod.get(app, NS_PROD, 'posts', 'g');
      expect(doc).toMatchObject({
        collection: 'posts',
        key: 'g',
        data: { status: 'open', score: 5 },
        reports: 2,
        counters: { views: 7 },
        marks: { star: 1, report: 2 },
        authorKind: 'user',
        authorUid: VIEWER_1,
        hiddenBy: MOD,
        sizeBytes: OPEN5_BYTES,
        version: 1,
      });
      expect(doc?.dataMd5).toMatch(/^[0-9a-f]{32}$/);
    });

    it('never reaches a private doc: scope is shared only', async () => {
      const app = freshApp('modpriv');
      await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'mine', { a: 1 });
      expect(await mod.get(app, NS_PROD, 'prefs', 'mine')).toBeNull();
      await expectCode(mod.setHidden(app, NS_PROD, 'prefs', 'mine', true, MOD), 'not_found');
      await expectCode(mod.delete(app, NS_PROD, 'prefs', 'mine'), 'not_found');
      expect(await store.get(ctx(app, NS_PROD, VIEWER_1), PREFS, 'mine')).not.toBeNull();
    });
  });

  describe('hide / unhide, seen through every viewer read path', () => {
    const keysOf = (r: { items: { key: string }[] }) => r.items.map((d) => d.key);

    async function seedHidden() {
      const app = freshApp('modhide');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      for (const [k, score] of [
        ['h1', 5],
        ['v1', 6],
      ] as const) {
        await store.put(v1, POSTS, k, { status: 'open', score });
        await store.mark(v1, POSTS, k, 'star');
        await store.increment(v1, POSTS, k, 'views', 3);
      }
      await report(app, POSTS, 'h1', R1);
      return { app, v1 };
    }

    it('a hidden doc is absent from get, getMany and every list shape; the visible control stays', async () => {
      const { app, v1 } = await seedHidden();
      expect(await mod.setHidden(app, NS_PROD, 'posts', 'h1', true, MOD)).toMatchObject({
        changed: true,
      });
      expect(await store.get(v1, POSTS, 'h1')).toBeNull();
      expect(await store.get(v1, POSTS, 'v1')).not.toBeNull();
      expect((await store.getMany(v1, POSTS, ['h1', 'v1'])).map((d) => d?.key ?? null)).toEqual([
        null,
        'v1',
      ]);
      const lists: [string, Parameters<DocStore['list']>[2]][] = [
        ['default', {}],
        ['-key', { sort: '-key' }],
        ['createdAt', { sort: 'createdAt' }],
        ['-updatedAt', { sort: '-updatedAt' }],
        ['index sort', { sort: 'score' }],
        ['index sort desc', { sort: '-score' }],
        ['index filter', { where: { status: 'open' } }],
        ['counter sort', { sort: '-counter:views' }],
        ['mark sort', { sort: 'mark:star' }],
        ['author=me', { author: 'me' }],
        ['markedBy=me', { markedBy: 'me', mark: 'star' }],
        ['keyPrefix', { keyPrefix: '' }],
      ];
      for (const [name, q] of lists) {
        expect({ name, keys: keysOf(await store.list(v1, POSTS, q)) }).toEqual({
          name,
          keys: ['v1'],
        });
      }
      // An anonymous viewer reads shared lists too.
      expect(keysOf(await store.list(ctx(app, NS_PROD, null), POSTS))).toEqual(['v1']);
    });

    it('writes to a hidden key are refused as not_found; delete reports nothing deleted', async () => {
      const { app, v1 } = await seedHidden();
      await mod.setHidden(app, NS_PROD, 'posts', 'h1', true, MOD);
      await expectCode(store.put(v1, POSTS, 'h1', { status: 'x' }), 'not_found');
      await expectCode(store.put(v1, POSTS, 'h1', { status: 'x' }, { ifVersion: 1 }), 'not_found');
      expect(await store.delete(v1, POSTS, 'h1')).toEqual({ deleted: false });
      await expectCode(store.mark(v1, POSTS, 'h1', 'vote'), 'not_found');
      await expectCode(store.unmark(v1, POSTS, 'h1', 'star'), 'not_found');
      await expectCode(store.mark(ctx(app, NS_PROD, R2), POSTS, 'h1', 'report'), 'not_found');
      await expectCode(store.increment(v1, POSTS, 'h1', 'views'), 'not_found');
      // Nothing changed underneath.
      const doc = await mod.get(app, NS_PROD, 'posts', 'h1');
      expect(doc).toMatchObject({
        version: 1,
        counters: { views: 3 },
        marks: { star: 1, report: 1 },
      });
    });

    it('a hidden counter-collection key cannot be re-created by an increment', async () => {
      const app = freshApp('modhidectr');
      await store.increment(ctx(app, NS_PROD, VIEWER_2), TALLIES, 't', 'plays');
      await mod.setHidden(app, NS_PROD, 'tallies', 't', true, MOD);
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_2), TALLIES, 't', 'plays'),
        'not_found'
      );
    });

    it('unhide restores the doc with its tallies; hide/unhide move the feed seq; repeats change nothing', async () => {
      const { app, v1 } = await seedHidden();
      const lastSeq = async () =>
        Number(
          (await h.raw(`SELECT last_seq FROM appdata.usage_app WHERE app_id = $1`, [app]))[0]
            .last_seq
        );
      const before = await lastSeq();
      const hide = await mod.setHidden(app, NS_PROD, 'posts', 'h1', true, MOD);
      expect(hide).toEqual({ changed: true, seq: before + 1 });
      expect(await mod.setHidden(app, NS_PROD, 'posts', 'h1', true, MOD)).toEqual({
        changed: false,
        seq: null,
      });
      const tomb = await h.raw(`SELECT key, seq FROM appdata.doc_tomb WHERE app_id = $1`, [app]);
      expect(tomb.map((t) => [t.key, Number(t.seq)])).toEqual([['h1', before + 1]]);

      const unhide = await mod.setHidden(app, NS_PROD, 'posts', 'h1', false, MOD);
      expect(unhide).toEqual({ changed: true, seq: before + 2 });
      const [row] = await h.raw(
        `SELECT seq, hidden_at, hidden_by FROM appdata.doc WHERE app_id = $1 AND key = 'h1'`,
        [app]
      );
      expect({ seq: Number(row.seq), at: row.hidden_at, by: row.hidden_by }).toEqual({
        seq: before + 2,
        at: null,
        by: null,
      });
      const got = await store.get(v1, POSTS, 'h1');
      expect(got).toMatchObject({
        key: 'h1',
        version: 1,
        counters: { views: 3 },
        marks: { star: 1 },
      });
      expect(keysOf(await store.list(v1, POSTS, { sort: '-score' }))).toEqual(['v1', 'h1']);
      expect(await mod.setHidden(app, NS_PROD, 'posts', 'h1', false, MOD)).toEqual({
        changed: false,
        seq: null,
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('hiding keeps the quota charge (the data is still stored)', async () => {
      const { app, v1 } = await seedHidden();
      const before = await store.usage(v1);
      await mod.setHidden(app, NS_PROD, 'posts', 'h1', true, MOD);
      expect(await store.usage(v1)).toEqual(before);
    });

    it('an absent key is not_found', async () => {
      const app = freshApp('modabsent');
      await expectCode(mod.setHidden(app, NS_PROD, 'posts', 'nope', true, MOD), 'not_found');
    });
  });

  describe('dismissing reports', () => {
    // PGlite's clock ticks in milliseconds, so a report and a dismissal in the same tick would
    // share a timestamp; a real server ticks in microseconds. Step past a tick around each.
    const tick = () => new Promise((r) => setTimeout(r, 5));

    it("closes the open reports, keeps every reporter's own mark, and a NEW report re-opens it", async () => {
      const app = freshApp('moddis');
      await seedQueue(app);
      await tick();
      expect(await mod.dismissReports(app, NS_PROD, 'posts', 'p1')).toEqual({ dismissed: 3 });
      await tick();
      expect(await queue(app)).not.toContain('posts/p1:3');
      const doc = (await mod.get(app, NS_PROD, 'posts', 'p1'))!;
      expect({ open: doc.reports, total: doc.marks.report }).toEqual({ open: 0, total: 3 });
      expect(doc.reportsDismissedAt).toBeInstanceOf(Date);
      // A reporter still sees their own report; they cannot withdraw it, and re-reporting is
      // not a new report — so they cannot re-open what was dismissed.
      expect((await store.get(ctx(app, NS_PROD, R1), POSTS, 'p1'))?.viewer?.marks).toContain(
        'report'
      );
      await expectCode(
        store.unmark(ctx(app, NS_PROD, R1), POSTS, 'p1', 'report'),
        'invalid_request'
      );
      await store.mark(ctx(app, NS_PROD, R1), POSTS, 'p1', 'report');
      await tick();
      expect(await queue(app)).not.toContain('posts/p1:1');
      expect((await mod.get(app, NS_PROD, 'posts', 'p1'))!.reports).toBe(0);
      // A new reporter re-opens it with exactly the new report.
      await report(app, POSTS, 'p1', R4);
      expect(await queue(app)).toContain('posts/p1:1');
    });

    it('unhide does not re-surface dismissed reports', async () => {
      const app = freshApp('moddisun');
      await seedQueue(app);
      await tick();
      await mod.dismissReports(app, NS_PROD, 'posts', 'p1');
      await tick();
      await mod.setHidden(app, NS_PROD, 'posts', 'p1', true, MOD);
      await mod.setHidden(app, NS_PROD, 'posts', 'p1', false, MOD);
      expect(await queue(app, { status: 'open' })).not.toContain('posts/p1:3');
      expect((await mod.get(app, NS_PROD, 'posts', 'p1'))!.reports).toBe(0);
    });

    it('a hidden document is not dismissable, and stays listed in the hidden and all views', async () => {
      const app = freshApp('moddishid');
      await seedQueue(app);
      await tick();
      // Dismissed while visible, then hidden: zero open reports, yet still reachable.
      await mod.dismissReports(app, NS_PROD, 'posts', 'p1');
      await mod.setHidden(app, NS_PROD, 'posts', 'p1', true, MOD);
      // Never reported at all, hidden by a moderator.
      await mod.setHidden(app, NS_PROD, 'posts', 'p4', true, MOD);
      await expectCode(mod.dismissReports(app, NS_PROD, 'posts', 'p1'), 'invalid_request');
      expect(await queue(app, { status: 'hidden' })).toEqual(['posts/p4:0', 'posts/p1:0']);
      expect(await queue(app, { status: 'all' })).toEqual([
        'board/b1:2',
        'posts/p6:2',
        'posts/p3:2',
        'posts/p2:1',
        'posts/p4:0',
        'posts/p1:0',
      ]);
      expect(await queue(app, { status: 'open' })).not.toContain('posts/p1:0');
    });

    it('is bound to the revision, and refuses a missing document', async () => {
      const app = freshApp('moddisrev');
      await seedQueue(app);
      const seen = (await mod.get(app, NS_PROD, 'posts', 'p1'))!.revision;
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p1', { status: 'edited' });
      await expectCode(
        mod.dismissReports(app, NS_PROD, 'posts', 'p1', { ifRevision: seen }),
        'version_conflict'
      );
      expect((await mod.get(app, NS_PROD, 'posts', 'p1'))!.reports).toBe(3);
      await expectCode(mod.dismissReports(app, NS_PROD, 'posts', 'nope'), 'not_found');
    });
  });

  describe('revision binding', () => {
    it('with ifRevision, hide and delete refuse a document that changed; nothing is written', async () => {
      const app = freshApp('modver');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, BOARD, 'x', { text: 'seen' });
      const seen = (await mod.get(app, NS_PROD, 'board', 'x'))!.revision;
      await store.put(v1, BOARD, 'x', { text: 'edited after the moderator looked' });
      await expectCode(
        mod.setHidden(app, NS_PROD, 'board', 'x', true, MOD, { ifRevision: seen }),
        'version_conflict'
      );
      await expectCode(
        mod.delete(app, NS_PROD, 'board', 'x', { ifRevision: seen }),
        'version_conflict'
      );
      expect(await store.get(v1, BOARD, 'x')).toMatchObject({ version: 2 });
      expect(await h.raw(`SELECT 1 FROM appdata.doc_tomb WHERE app_id = $1`, [app])).toEqual([]);
      // Positive control: the current revision is accepted.
      const current = (await mod.get(app, NS_PROD, 'board', 'x'))!.revision;
      expect(await mod.delete(app, NS_PROD, 'board', 'x', { ifRevision: current })).toMatchObject({
        deleted: true,
      });
    });

    it('a key deleted and re-created by its author is a new revision, though its version is 1 again', async () => {
      const app = freshApp('modaba');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, BOARD, 'x', { text: 'reported content' });
      const seen = (await mod.get(app, NS_PROD, 'board', 'x'))!;
      await store.delete(v1, BOARD, 'x');
      await store.put(v1, BOARD, 'x', { text: 'new content nobody reviewed' });
      const now = (await mod.get(app, NS_PROD, 'board', 'x'))!;
      expect({ seen: seen.version, now: now.version }).toEqual({ seen: 1, now: 1 });
      expect(now.revision).not.toBe(seen.revision);
      await expectCode(
        mod.delete(app, NS_PROD, 'board', 'x', { ifRevision: seen.revision }),
        'version_conflict'
      );
      expect(await store.get(v1, BOARD, 'x')).toMatchObject({
        data: { text: 'new content nobody reviewed' },
      });
    });
  });

  describe('hard delete', () => {
    it('removes the doc, its index rows, tallies and marks; refunds the author; leaves a tombstone', async () => {
      const app = freshApp('moddel');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const v2 = ctx(app, NS_PROD, VIEWER_2);
      await store.put(v1, POSTS, 'd1', { status: 'open', score: 5 });
      await store.put(v1, POSTS, 'k1', { status: 'keep', score: 1 });
      await store.put(v2, POSTS, 'k2', { status: 'keep', score: 2 });
      await store.mark(v2, POSTS, 'd1', 'star');
      await store.increment(v2, POSTS, 'd1', 'views', 4);
      await report(app, POSTS, 'd1', R1, R2);
      const appBefore = (await store.usage(v1)).app;
      const v1Before = (await store.usage(v1)).viewer!;
      const v2Before = (await store.usage(v2)).viewer!;

      expect(await mod.delete(app, NS_PROD, 'posts', 'd1')).toMatchObject({
        deleted: true,
        sizeBytes: OPEN5_BYTES,
      });

      const count = async (table: string) =>
        Number(
          (
            await h.raw(
              `SELECT count(*)::int AS n FROM appdata.${table} WHERE app_id = $1 AND key = 'd1'`,
              [app]
            )
          )[0].n
        );
      expect({
        doc: await count('doc'),
        index: await count('doc_index'),
        tally: await count('doc_tally'),
        mark: await count('doc_mark'),
        tomb: await count('doc_tomb'),
      }).toEqual({ doc: 0, index: 0, tally: 0, mark: 0, tomb: 1 });

      expect((await store.usage(v1)).app).toEqual({
        bytes: appBefore.bytes - OPEN5_BYTES,
        docs: appBefore.docs - 1,
      });
      expect((await store.usage(v1)).viewer).toEqual({
        bytes: v1Before.bytes - OPEN5_BYTES,
        docs: v1Before.docs - 1,
      });
      // The marker/incrementer was not charged for d1 and is not refunded for it.
      expect((await store.usage(v2)).viewer).toEqual(v2Before);
      await assertUsageConsistent(h, app, NS_PROD);

      expect(await store.get(v1, POSTS, 'd1')).toBeNull();
      expect((await store.list(v1, POSTS)).items.map((d) => d.key)).toEqual(['k1', 'k2']);
      // The key is free again and starts from zero.
      const again = await store.put(v1, POSTS, 'd1', { status: 'open', score: 5 });
      expect(again).toMatchObject({
        version: 1,
        counters: { views: 0 },
        marks: { star: 0, vote: 0 },
      });
      await expectCode(mod.delete(app, NS_PROD, 'posts', 'nope'), 'not_found');
    });

    it('a hidden doc can be deleted; the tombstone takes the delete seq', async () => {
      const app = freshApp('moddelhid');
      await store.put(ctx(app, NS_PROD, VIEWER_1), BOARD, 'x', { text: 'bad' });
      await mod.setHidden(app, NS_PROD, 'board', 'x', true, MOD);
      const del = await mod.delete(app, NS_PROD, 'board', 'x');
      const tomb = await h.raw(`SELECT seq FROM appdata.doc_tomb WHERE app_id = $1 AND key = 'x'`, [
        app,
      ]);
      expect(tomb.map((t) => Number(t.seq))).toEqual([del.seq]);
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('a counter-created doc refunds the viewer whose increment created it', async () => {
      const app = freshApp('moddelctr');
      const v2 = ctx(app, NS_PROD, VIEWER_2);
      await store.increment(v2, TALLIES, 't', 'plays', 5);
      expect((await store.usage(v2)).viewer?.docs).toBe(1);
      await mod.delete(app, NS_PROD, 'tallies', 't');
      expect((await store.usage(v2)).viewer).toEqual({ bytes: 0, docs: 0 });
      expect((await store.usage(v2)).app).toEqual({ bytes: 0, docs: 0 });
      await assertUsageConsistent(h, app, NS_PROD);
    });
  });

  describe('cross-app isolation of moderator actions', () => {
    it('acting on app A never reads or changes app B, even for the same collection and key', async () => {
      const a = freshApp('modisoA');
      const b = freshApp('modisoB');
      for (const app of [a, b]) {
        await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'same', { status: 'open', score: 5 });
        await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'same', 'star');
        await report(app, POSTS, 'same', R1);
      }
      await store.put(ctx(b, NS_PROD, VIEWER_1), POSTS, 'only_b', { status: 'open' });
      await report(b, POSTS, 'only_b', R1, R2);
      const bSnapshot = async () => ({
        doc: await mod.get(b, NS_PROD, 'posts', 'same'),
        usage: await store.usage(ctx(b, NS_PROD, VIEWER_1)),
        tombs: await h.raw(`SELECT key FROM appdata.doc_tomb WHERE app_id = $1`, [b]),
        queue: await queue(b),
      });
      const bBefore = await bSnapshot();
      expect(bBefore.queue).toEqual(['posts/only_b:2', 'posts/same:1']);

      expect(await queue(a)).toEqual(['posts/same:1']);
      await mod.setHidden(a, NS_PROD, 'posts', 'same', true, MOD);
      expect(await store.get(ctx(b, NS_PROD, VIEWER_1), POSTS, 'same')).not.toBeNull();
      await expectCode(mod.setHidden(a, NS_PROD, 'posts', 'only_b', true, MOD), 'not_found');
      await expectCode(mod.delete(a, NS_PROD, 'posts', 'only_b'), 'not_found');
      await mod.delete(a, NS_PROD, 'posts', 'same');

      expect(await bSnapshot()).toEqual(bBefore);
      expect(await mod.get(a, NS_PROD, 'posts', 'same')).toBeNull();
      await assertUsageConsistent(h, a, NS_PROD);
      await assertUsageConsistent(h, b, NS_PROD);
    });
  });
}

describe('the queue reads what it lists, not the whole app (its own database, so its statistics are its own)', () => {
  let h: Harness;
  let mod: DocStoreModeration;
  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true });
    harnesses.push(h);
    mod = createDocStoreModeration({ db: h.db });
  });
  afterAll(async () => {
    await h?.close();
  });
  const queue = async (app: string, status: 'open' | 'hidden' | 'all') =>
    (await mod.listReported(app, NS_PROD, { status, limit: 50 })).map(
      (r) => `${r.collection}/${r.key}:${r.reports}`
    );

  /** Rows read from `appdata.doc` and `appdata.doc_mark` by the queue statement, from its own executed plan. */
  async function docRowsRead(app: string, status: 'open' | 'hidden' | 'all') {
    const before = h.statements.length;
    await mod.listReported(app, NS_PROD, { status, limit: 51 });
    const st = h.statements.slice(before).find((x) => /ORDER BY q\.reports DESC/.test(x.sql));
    if (!st) throw new Error('queue statement not recorded');
    const [row] = await h.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${st.sql}`, st.params);
    const plan = (row['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0].Plan;
    const read = { doc: 0, doc_mark: 0 };
    const walk = (n: Record<string, unknown>) => {
      // Rows a scan of `doc` touched: those it returned AND those its filter threw away (a
      // filter pushed into the scan hides a full read behind a small "Actual Rows").
      const rel = n['Relation Name'];
      if (rel === 'doc' || rel === 'doc_mark') {
        const touched =
          Number(n['Actual Rows'] ?? 0) +
          Number(n['Rows Removed by Filter'] ?? 0) +
          Number(n['Rows Removed by Index Recheck'] ?? 0);
        read[rel] += touched * Number(n['Actual Loops'] ?? 1);
      }
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk(plan);
    return read;
  }

  it('with 5,000 shared documents, 3 reported and 5,000 other marks, each view reads a handful of rows', async () => {
    const app = 'ab_MODSCAN';
    // Bulk rows straight into the table: the queue's cost is the question, not the write path.
    await h.raw(
      `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind)
         SELECT $1, 'prod', 'posts', 0, 'k' || g, '{}', 1, g, 101, 'user' FROM generate_series(1, 5000) g`,
      [app]
    );
    // Many marks that are NOT reports: the queue must not read them.
    await h.raw(
      `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id)
         SELECT $1, 'prod', 'posts', 'k' || g, 'vote', 4242 FROM generate_series(1, 5000) g`,
      [app]
    );
    for (const k of ['k1', 'k2', 'k3']) {
      await h.raw(
        `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id) VALUES ($1, 'prod', 'posts', $2, 'report', 3101)`,
        [app, k]
      );
    }
    await h.raw(
      `UPDATE appdata.doc SET hidden_at = now(), hidden_by = 9 WHERE app_id = $1 AND key IN ('k3', 'k4')`,
      [app]
    );
    await h.raw(`ANALYZE appdata.doc`);
    await h.raw(`ANALYZE appdata.doc_mark`);
    // Positive control: the queue lists what it should (k4: hidden, never reported).
    expect(await queue(app, 'all')).toEqual([
      'posts/k3:1',
      'posts/k2:1',
      'posts/k1:1',
      'posts/k4:0',
    ]);
    const read = {
      open: await docRowsRead(app, 'open'),
      hidden: await docRowsRead(app, 'hidden'),
      all: await docRowsRead(app, 'all'),
    };
    // A scan of the app would read 5,000 documents or 5,000+ marks; the queue reads the
    // reported and hidden ones.
    expect(read).toEqual({
      open: { doc: expect.any(Number), doc_mark: expect.any(Number) },
      hidden: { doc: expect.any(Number), doc_mark: expect.any(Number) },
      all: { doc: expect.any(Number), doc_mark: expect.any(Number) },
    });
    for (const [view, r] of Object.entries(read)) {
      expect({ view, doc: r.doc <= 10, doc_mark: r.doc_mark <= 10 }).toEqual({
        view,
        doc: true,
        doc_mark: true,
      });
    }
    // Positive control: the reads were measured at all.
    expect(read.open.doc_mark).toBeGreaterThan(0);
  });
});

describe('doc-store moderation on PGlite — RLS disabled: the module predicates alone', () => {
  defineModerationSuite(false);
});

describe('doc-store moderation on PGlite — RLS on: both layers', () => {
  defineModerationSuite(true);
});

describe('runtime isolation shape of every moderation statement', () => {
  it('every appdata statement carried the bound app id and namespace as $1/$2 and passed the shape scan', () => {
    const statements = harnesses.flatMap((x) => x.statements);
    // Positive control: the recorder saw the assembled moderation SQL itself.
    expect(statements.filter((s) => /SELECT q\.\* FROM \(/.test(s.sql)).length).toBeGreaterThan(10);
    expect(statements.filter((s) => /SET hidden_at = now\(\)/.test(s.sql)).length).toBeGreaterThan(
      5
    );
    expect(
      statements.filter((s) => /ORDER BY q\.reports DESC, q\.updated_at DESC/.test(s.sql)).length
    ).toBeGreaterThan(0);
    expect(harnesses.flatMap((x) => x.violations)).toEqual([]);
  });
});
