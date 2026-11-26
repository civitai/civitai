import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStorePrivateFeed } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStorePrivateFeed } from '~/server/services/apps/doc-store';
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
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry PRIVATE feed's reads (`createDocStorePrivateFeed`) on the embedded Postgres, as
 * `appdata_rw` with row-level security ON and OFF (the module's own predicates alone). Row-level
 * security binds an app and a namespace, never a user, so the `scope_uid` predicate is the only
 * thing keeping one user's key space from another's: these cases are its guard.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.each([{ rls: true }, { rls: false }])('the registry private feed (rls %o)', (opts) => {
  let h: Harness;
  let store: DocStore;
  let feed: DocStorePrivateFeed;
  let app: string;
  let other: string;

  beforeAll(async () => {
    h = await createPgliteHarness(opts);
    store = createDocStore({ db: h.db });
    feed = createDocStorePrivateFeed({ db: h.db });
    app = freshApp('pfeed');
    other = freshApp('pfeedother');
    await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'theme', { t: 'MINE-CANARY-1' });
    await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'lang', { t: 'MINE-CANARY-2' });
    await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'gone', { t: 'DELETED-CANARY' });
    await store.delete(ctx(app, NS_PROD, VIEWER_1), PREFS, 'gone');
    // The SAME key in another user's key space.
    await store.put(ctx(app, NS_PROD, VIEWER_2), PREFS, 'theme', { t: 'OTHER-USER-CANARY' });
    await store.put(ctx(app, NS_PROD, VIEWER_1), BOARD, 'b1', { t: 'SHARED-CANARY' });
    await store.put(ctx(app, NS_DEV, VIEWER_1), PREFS, 'theme', { t: 'DEV-CANARY' });
    await store.put(ctx(other, NS_PROD, VIEWER_1), PREFS, 'theme', { t: 'OTHER-APP-CANARY' });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("reads one user's private documents of one collection, by key, each with its record id", async () => {
    const docs = await feed.privateDocuments(app, 'prefs', VIEWER_1, '', 100);
    expect(docs.map((d) => [d.key, d.data, d.version])).toEqual([
      ['lang', { t: 'MINE-CANARY-2' }, 1],
      ['theme', { t: 'MINE-CANARY-1' }, 1],
    ]);
    for (const d of docs) expect(d.recordId).toMatch(UUID_RE);
    expect(new Set(docs.map((d) => d.recordId)).size).toBe(2);
    const versions = await feed.privateVersions(app, 'prefs', VIEWER_1, '', 100);
    expect(versions).toEqual(
      docs.map(({ key, recordId, version, seq }) => ({ key, recordId, version, seq }))
    );
  });

  it('pages by key', async () => {
    const first = await feed.privateDocuments(app, 'prefs', VIEWER_1, '', 1);
    expect(first.map((d) => d.key)).toEqual(['lang']);
    const next = await feed.privateDocuments(app, 'prefs', VIEWER_1, 'lang', 1);
    expect(next.map((d) => d.key)).toEqual(['theme']);
  });

  it("🔴 never another user's key space, a shared document, another namespace or another app", async () => {
    const everything = JSON.stringify([
      await feed.privateDocuments(app, 'prefs', VIEWER_1, '', 100),
      await feed.privateDocuments(app, 'board', VIEWER_1, '', 100),
      await feed.privateVersions(app, 'board', VIEWER_1, '', 100),
    ]);
    for (const canary of [
      'OTHER-USER-CANARY',
      'SHARED-CANARY',
      'DEV-CANARY',
      'OTHER-APP-CANARY',
      'DELETED-CANARY',
    ]) {
      expect(everything).not.toContain(canary);
    }
    // Positive controls: each of those rows is there, and its own reader gets it.
    expect(
      (await feed.privateDocuments(app, 'prefs', VIEWER_2, '', 100)).map((d) => d.data.t)
    ).toEqual(['OTHER-USER-CANARY']);
    expect(
      (await feed.privateDocuments(other, 'prefs', VIEWER_1, '', 100)).map((d) => d.data.t)
    ).toEqual(['OTHER-APP-CANARY']);
  });

  it('refuses malformed input, and user 0 (the shared key space), before it reaches SQL', async () => {
    await expectCode(feed.privateDocuments(app, 'Bad Name', VIEWER_1, '', 100), 'invalid_request');
    await expectCode(feed.privateVersions(app, 'prefs', VIEWER_1, 'a/b', 100), 'invalid_request');
    await expectCode(feed.privateVersions(app, 'prefs', VIEWER_1, '', 5_000), 'invalid_request');
    await expect(feed.privateDocuments(app, 'board', 0, '', 100)).rejects.toThrow(
      'doc-store: malformed user id'
    );
    await expect(feed.privateVersions(app, 'prefs', -3, '', 100)).rejects.toThrow(
      'doc-store: malformed user id'
    );
  });

  it('every statement it sent carried the bound app and the production namespace', () => {
    const PRIVATE_SQL = [
      'SELECT d.key, d.version, d.record_id',
      'SELECT d.key, d.data, d.version, d.record_id',
    ];
    const sent = h.statements.filter((s) => PRIVATE_SQL.some((f) => s.sql.includes(f)));
    expect(PRIVATE_SQL.filter((f) => !sent.some((s) => s.sql.includes(f)))).toEqual([]);
    expect(new Set(sent.map((s) => s.ns))).toEqual(new Set([NS_PROD]));
    expect(h.violations).toEqual([]);
  });
});
