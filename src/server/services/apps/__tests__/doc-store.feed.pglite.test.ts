import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreFeed, DocStoreModeration } from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreModeration,
} from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  BOARD,
  ctx,
  expectCode,
  freshApp,
  NS_DEV,
  NS_PROD,
  PREFS,
  VIEWER_1,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry feed's reads (`createDocStoreFeed`) on the embedded Postgres, as `appdata_rw` with
 * row-level security ON and OFF (the module's own predicates alone). Keys and bodies are literals;
 * seqs are asserted by the order the store guarantees, never by reading them back as expectations.
 */

const MOD = 9_301;

describe.each([{ rls: true }, { rls: false }])('the registry feed (rls %o)', (opts) => {
  let h: Harness;
  let store: DocStore;
  let mod: DocStoreModeration;
  let feed: DocStoreFeed;
  let app: string;
  let other: string;
  let head: number;

  beforeAll(async () => {
    h = await createPgliteHarness(opts);
    store = createDocStore({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
    feed = createDocStoreFeed({ db: h.db });
    app = freshApp('feed');
    other = freshApp('feedother');
    const me = ctx(app, NS_PROD, VIEWER_1);
    await store.put(me, BOARD, 'b1', { t: 'one' });
    await store.put(me, PREFS, 'secret', { t: 'PRIVATE-FEED-CANARY' });
    await store.put(me, BOARD, 'b2', { t: 'two' });
    await store.put(me, BOARD, 'b4', { t: 'four' });
    await store.put(ctx(app, NS_DEV, VIEWER_1), BOARD, 'b3', { t: 'DEV-FEED-CANARY' });
    await store.put(ctx(other, NS_PROD, VIEWER_1), BOARD, 'x1', { t: 'OTHER-APP-CANARY' });
    await mod.setHidden(app, NS_PROD, 'board', 'b2', true, MOD);
    await store.delete(me, BOARD, 'b1');
    head = await feed.feedHead(app);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the full read: visible shared documents of production only', async () => {
    expect(await feed.feedDocuments(app, 'board', '', head, 100)).toEqual([
      { key: 'b4', data: { t: 'four' }, version: 1, seq: expect.any(Number) },
    ]);
  });

  it('🔴 a private collection reads as empty, though it holds a document', async () => {
    expect(await feed.feedDocuments(app, 'prefs', '', head, 100)).toEqual([]);
    expect(await feed.feedChanges(app, 'prefs', 0, head, 100)).toEqual({ docs: [], tombs: [] });
  });

  it('the seq read: writes in seq order with hidden flagged, and the hide and delete as tombstones', async () => {
    const page = await feed.feedChanges(app, 'board', 0, head, 100);
    expect(page.docs.map((d) => [d.key, d.data, d.hidden])).toEqual([
      ['b2', { t: 'two' }, true],
      ['b4', { t: 'four' }, false],
    ]);
    expect(page.tombs.map((t) => t.key)).toEqual(['b2', 'b1']);
    const seqs = [...page.docs.map((d) => d.seq), ...page.tombs.map((t) => t.seq)];
    expect(Math.max(...seqs)).toBe(head);
  });

  it('the range is exclusive below and inclusive above', async () => {
    const all = await feed.feedChanges(app, 'board', 0, head, 100);
    const b4 = all.docs.find((d) => d.key === 'b4')!.seq;
    const after = await feed.feedChanges(app, 'board', b4, head, 100);
    expect(after.docs).toEqual([]);
    expect(after.tombs.map((t) => t.key)).toEqual(['b2', 'b1']);
    const upTo = await feed.feedChanges(app, 'board', 0, b4, 100);
    expect(upTo.docs.map((d) => d.key)).toEqual(['b2', 'b4']);
    expect(upTo.tombs).toEqual([]);
  });

  it('🔴 nothing private, from another namespace or from another app ever comes back', async () => {
    const everything = JSON.stringify([
      await feed.feedDocuments(app, 'board', '', head, 100),
      await feed.feedChanges(app, 'board', 0, head, 100),
      await feed.feedChanges(app, 'prefs', 0, head, 100),
    ]);
    for (const canary of ['PRIVATE-FEED-CANARY', 'DEV-FEED-CANARY', 'OTHER-APP-CANARY', 'secret']) {
      expect(everything).not.toContain(canary);
    }
    // Positive control: the other app's row is there, and its own feed returns it.
    expect(
      (await feed.feedDocuments(other, 'board', '', await feed.feedHead(other), 100)).map(
        (d) => d.key
      )
    ).toEqual(['x1']);
  });

  it('the witness: a deleted key has only its tombstone, a live one only its document', async () => {
    const gone = await feed.feedWitness(app, 'board', 'b1');
    expect([gone.docSeq, typeof gone.tombSeq]).toEqual([null, 'number']);
    const live = await feed.feedWitness(app, 'board', 'b4');
    expect([typeof live.docSeq, live.tombSeq]).toEqual(['number', null]);
  });

  it('a namespace never written reads as seq 0 and holds nothing', async () => {
    const empty = freshApp('feedempty');
    expect(await feed.feedHead(empty)).toBe(0);
    expect(await feed.feedDocuments(empty, 'board', '', 0, 100)).toEqual([]);
  });

  it('refuses malformed input before it reaches SQL', async () => {
    await expectCode(feed.feedDocuments(app, 'Bad Name', '', head, 100), 'invalid_request');
    await expectCode(feed.feedChanges(app, 'board', -1, head, 100), 'invalid_request');
    await expectCode(feed.feedChanges(app, 'board', 0, head, 5_000), 'invalid_request');
    await expectCode(feed.feedWitness(app, 'board', 'a/b'), 'invalid_request');
  });

  it('every statement it sent carried the bound app and the production namespace', () => {
    // Fragments only the feed's own statements contain (head, both seq reads, the full read,
    // both witness reads), so the namespace check is about the feed and nothing else.
    const FEED_SQL = [
      'SELECT u.last_seq FROM',
      'AND d.seq > $4::bigint',
      'AND tb.seq > $4::bigint',
      'AND d.hidden_at IS NULL AND d.seq <= $5',
      'SELECT d.seq FROM appdata',
      'tb.scope_uid = 0 AND tb.key = $4',
    ];
    const feedStatements = h.statements.filter((s) => FEED_SQL.some((f) => s.sql.includes(f)));
    // Positive control: every feed statement kind was seen.
    expect(FEED_SQL.filter((f) => !feedStatements.some((s) => s.sql.includes(f)))).toEqual([]);
    expect(new Set(feedStatements.map((s) => s.ns))).toEqual(new Set([NS_PROD]));
    expect(h.violations).toEqual([]);
  });
});
