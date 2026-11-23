import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStorePrivateFeed } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStorePrivateFeed } from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness, type Row } from './doc-store.harness';
import {
  BOARD,
  ctx,
  freshApp,
  NS_DEV,
  NS_PROD,
  PREFS,
  VIEWER_1,
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What a write answers beside its record (`WrittenDocRecord`): the document's `seq` and its
 * `record_id`, and a delete's tombstone `seq`. The answer is checked against the stored rows, read
 * back by the superuser with SQL of this file's own (a different path from the store's RETURNING),
 * and every seq is a literal: a fresh app namespace numbers its writes 1, 2, 3, ….
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.each([{ rls: true }, { rls: false }])(
  'a write answers its seq and record id (rls %o)',
  (opts) => {
    let h: Harness;
    let store: DocStore;
    let feed: DocStorePrivateFeed;

    beforeAll(async () => {
      h = await createPgliteHarness(opts);
      store = createDocStore({ db: h.db });
      feed = createDocStorePrivateFeed({ db: h.db });
    });
    afterAll(async () => {
      expect(h.violations).toEqual([]);
      await h?.close();
    });

    /** The stored row of one document, or undefined. */
    async function stored(app: string, ns: string, coll: string, scope: number, key: string) {
      const rows: Row[] = await h.raw(
        `SELECT d.seq, d.record_id::text AS record_id FROM appdata.doc d
        WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4 AND d.key = $5`,
        [app, ns, coll, scope, key]
      );
      return rows.at(0);
    }

    it('create and put answer the seq they stamped and the row’s record id, private and shared', async () => {
      const app = freshApp('WSEQ');
      const me = ctx(app, NS_PROD, VIEWER_1);
      const a = await store.put(me, PREFS, 'p1', { n: 1 });
      const b = await store.create(me, BOARD, { t: 'first' });
      const c = await store.put(me, PREFS, 'p1', { n: 2 });
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);

      const p1 = await stored(app, NS_PROD, 'prefs', VIEWER_1, 'p1');
      const b1 = await stored(app, NS_PROD, 'board', 0, b.key);
      expect(Number(p1?.seq)).toBe(3);
      expect(Number(b1?.seq)).toBe(2);
      expect(a.recordId).toMatch(UUID_RE);
      expect(b.recordId).toMatch(UUID_RE);
      // An update keeps the row, so its record id; the create is another row.
      expect(c.recordId).toBe(a.recordId);
      expect(c.recordId).toBe(p1?.record_id);
      expect(b.recordId).toBe(b1?.record_id);
      expect(b.recordId).not.toBe(a.recordId);
    });

    it('a key deleted and created again is a new row: a new record id and a later seq', async () => {
      const app = freshApp('WSEQRE');
      const me = ctx(app, NS_PROD, VIEWER_1);
      const first = await store.put(me, PREFS, 'k', { n: 1 });
      expect(await store.delete(me, PREFS, 'k')).toEqual({ deleted: true, seq: 2 });
      const again = await store.put(me, PREFS, 'k', { n: 1 });
      expect({ version: again.version, seq: again.seq }).toEqual({ version: 1, seq: 3 });
      expect(again.recordId).toMatch(UUID_RE);
      expect(again.recordId).not.toBe(first.recordId);
    });

    it('a delete answers its tombstone’s seq; one that removed nothing answers no seq and writes none', async () => {
      const app = freshApp('WSEQDEL');
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, BOARD, 's1', { t: 'one' });
      await store.put(me, PREFS, 'p1', { n: 1 });
      expect(await store.delete(me, BOARD, 's1')).toEqual({ deleted: true, seq: 3 });
      expect(await store.delete(me, PREFS, 'p1')).toEqual({ deleted: true, seq: 4 });
      const tombs = await h.raw(
        `SELECT tb.coll, tb.key, tb.seq FROM appdata.doc_tomb tb WHERE tb.app_id = $1 ORDER BY tb.seq`,
        [app]
      );
      expect(tombs.map((r) => [r.coll, r.key, Number(r.seq)])).toEqual([
        ['board', 's1', 3],
        ['prefs', 'p1', 4],
      ]);
      // Nothing there: exactly `{ deleted: false }`, and the head does not move.
      expect(await store.delete(me, PREFS, 'never')).toEqual({ deleted: false });
      expect(await feed.privateHead(app)).toBe(4);
    });

    it('writes in another namespace number on their own; the head is the production namespace’s', async () => {
      const app = freshApp('WSEQNS');
      const dev = await store.put(ctx(app, NS_DEV, VIEWER_1), PREFS, 'k', { n: 1 });
      const prod1 = await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'k', { n: 1 });
      const prod2 = await store.put(ctx(app, NS_PROD, VIEWER_2), PREFS, 'k', { n: 1 });
      expect([dev.seq, prod1.seq, prod2.seq]).toEqual([1, 1, 2]);
      expect(await feed.privateHead(app)).toBe(2);
      // A namespace nothing was written to has head 0.
      expect(await feed.privateHead(freshApp('WSEQEMPTY'))).toBe(0);
    });

    it("the private feed's reads carry each document's seq", async () => {
      const app = freshApp('WSEQFEED');
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, PREFS, 'b', { n: 1 });
      await store.put(me, BOARD, 'shared', { t: 'x' });
      await store.put(me, PREFS, 'a', { n: 1 });
      await store.put(me, PREFS, 'b', { n: 2 });
      expect(
        (await feed.privateVersions(app, 'prefs', VIEWER_1, '', 100)).map((v) => [v.key, v.seq])
      ).toEqual([
        ['a', 3],
        ['b', 4],
      ]);
      expect(
        (await feed.privateDocuments(app, 'prefs', VIEWER_1, '', 100)).map((d) => [d.key, d.seq])
      ).toEqual([
        ['a', 3],
        ['b', 4],
      ]);
      expect(await feed.privateHead(app)).toBe(4);
    });
  }
);

describe('putIfUnchanged answers the stored seq and record id, and writes nothing', () => {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true });
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  it('an identical shared put: the stored document at its own seq; the head does not move', async () => {
    const app = freshApp('WSEQSAME');
    const me = ctx(app, NS_PROD, VIEWER_1);
    const written = await store.put(me, BOARD, 'k', { t: 'same' });
    await store.put(me, BOARD, 'other', { t: 'later' });
    const same = await store.putIfUnchanged(me, BOARD, 'k', { t: 'same' });
    expect(same && { seq: same.seq, recordId: same.recordId, version: same.version }).toEqual({
      seq: 1,
      recordId: written.recordId,
      version: 1,
    });
    const [u] = await h.raw(
      `SELECT u.last_seq FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2`,
      [app, NS_PROD]
    );
    expect(Number(u.last_seq)).toBe(2);
  });
});
