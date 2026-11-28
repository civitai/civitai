import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DocStore,
  DocStoreFeed,
  DocStoreModeration,
  DocStorePrivateFeed,
  DocStoreRater,
} from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreModeration,
  createDocStorePrivateFeed,
  createDocStoreRater,
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
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry PER-VIEWER stream's reads (`createDocStorePrivateFeed`'s `viewerVersions` /
 * `viewerDocuments`, for `registry-adapter/viewer-feed.ts`) on the embedded Postgres with the
 * content-level columns migrated, as `appdata_rw` with row-level security ON. Ratings by the real
 * rater, hides by the real moderation. The reads are REST's author arm of `sharedDocLevelVisible`:
 * ONE user's OWN shared documents, an unrated one always, a rated one only within the domain ceiling
 * (`null` = content levels off: every one), never a hidden one, another author's, a private one,
 * another namespace's or another app's. Every body is a distinct canary.
 */

const MOD = 9_481;

describe('the per-viewer stream reads (rls on)', () => {
  let h: Harness;
  let store: DocStore;
  let feed: DocStorePrivateFeed;
  let shared: DocStoreFeed;
  let mod: DocStoreModeration;
  let rater: DocStoreRater;
  let app: string;
  let other: string;

  const rate = async (key: string, level: number) => {
    const seq = (await shared.feedWitness(app, BOARD.name, key)).docSeq;
    const out = await rater.applyRating(app, NS_PROD, BOARD.name, key, { seq: seq ?? 0, level });
    expect(out.applied).toBe(true);
  };

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true, docLevels: true });
    store = createDocStore({ db: h.db });
    feed = createDocStorePrivateFeed({ db: h.db });
    shared = createDocStoreFeed({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
    rater = createDocStoreRater({ db: h.db });
    app = freshApp('vfeed');
    other = freshApp('vfeedother');
    const me = ctx(app, NS_PROD, VIEWER_1);
    const at: Array<[string, number | null]> = [
      ['m01-pg', 1],
      ['m04-r', 4],
      ['m16-xxx', 16],
      ['m32-blocked', 32],
      ['mu-unrated', null],
      ['mh-hidden', 1],
    ];
    for (const [key, level] of at) {
      await store.put(me, BOARD, key, { t: `MINE-${key}` });
      if (level !== null) await rate(key, level);
    }
    await mod.setHidden(app, NS_PROD, BOARD.name, 'mh-hidden', true, MOD);
    await store.put(me, BOARD, 'mg-gone', { t: 'DELETED-CANARY' });
    await store.delete(me, BOARD, 'mg-gone');
    await store.put(ctx(app, NS_PROD, VIEWER_2), BOARD, 'o01-pg', { t: 'OTHER-AUTHOR-CANARY' });
    await rate('o01-pg', 1);
    await store.put(me, PREFS, 'p-private', { t: 'PRIVATE-CANARY' });
    await store.put(ctx(app, NS_DEV, VIEWER_1), BOARD, 'd-dev', { t: 'DEV-CANARY' });
    await store.put(ctx(other, NS_PROD, VIEWER_1), BOARD, 'x-other', { t: 'OTHER-APP-CANARY' });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('🔴 levels on: the viewer’s own visible documents, an unrated one always, a rated one only within the domain ceiling', async () => {
    // Ceiling PG | PG13 | R: the XXX and Blocked ones are hidden from their own author.
    const docs = await feed.viewerDocuments(app, 'board', VIEWER_1, 7, '', 100);
    expect(docs.map((d) => [d.key, d.data.t, d.version])).toEqual([
      ['m01-pg', 'MINE-m01-pg', 1],
      ['m04-r', 'MINE-m04-r', 1],
      ['mu-unrated', 'MINE-mu-unrated', 1],
    ]);
    for (const d of docs) {
      expect(Object.keys(d).sort()).toEqual(
        ['createdAt', 'data', 'key', 'seq', 'updatedAt', 'version'].sort()
      );
      expect(d.seq).toBe((await shared.feedWitness(app, 'board', d.key)).docSeq);
    }
    const versions = await feed.viewerVersions(app, 'board', VIEWER_1, 7, '', 100);
    expect(versions).toEqual(docs.map(({ key, version, seq }) => ({ key, version, seq })));
    // An SFW ceiling narrows it to PG and the unrated one.
    expect(
      (await feed.viewerVersions(app, 'board', VIEWER_1, 3, '', 100)).map((v) => v.key)
    ).toEqual(['m01-pg', 'mu-unrated']);
  });

  it('levels off (domain null): every one of the viewer’s visible documents, whatever its rating', async () => {
    expect(
      (await feed.viewerVersions(app, 'board', VIEWER_1, null, '', 100)).map((v) => v.key)
    ).toEqual(['m01-pg', 'm04-r', 'm16-xxx', 'm32-blocked', 'mu-unrated']);
  });

  it('pages by key', async () => {
    const first = await feed.viewerDocuments(app, 'board', VIEWER_1, null, '', 2);
    expect(first.map((d) => d.key)).toEqual(['m01-pg', 'm04-r']);
    const next = await feed.viewerDocuments(app, 'board', VIEWER_1, null, 'm04-r', 2);
    expect(next.map((d) => d.key)).toEqual(['m16-xxx', 'm32-blocked']);
  });

  it("🔴 never another author's document, a hidden or deleted one, a private one, another namespace or another app", async () => {
    const everything = JSON.stringify([
      await feed.viewerDocuments(app, 'board', VIEWER_1, null, '', 100),
      await feed.viewerDocuments(app, 'prefs', VIEWER_1, null, '', 100),
    ]);
    for (const canary of [
      'OTHER-AUTHOR-CANARY',
      'DELETED-CANARY',
      'PRIVATE-CANARY',
      'DEV-CANARY',
      'OTHER-APP-CANARY',
      'mh-hidden',
    ]) {
      expect(everything).not.toContain(canary);
    }
    // Positive controls: those rows exist, and their own readers get them.
    expect(
      (await feed.viewerDocuments(app, 'board', VIEWER_2, null, '', 100)).map((d) => d.data.t)
    ).toEqual(['OTHER-AUTHOR-CANARY']);
    expect(
      (await feed.viewerDocuments(other, 'board', VIEWER_1, null, '', 100)).map((d) => d.data.t)
    ).toEqual(['OTHER-APP-CANARY']);
    expect(
      (await feed.privateDocuments(app, 'prefs', VIEWER_1, '', 100)).map((d) => d.data.t)
    ).toEqual(['PRIVATE-CANARY']);
  });

  it('refuses malformed input, user 0 and a malformed level before it reaches SQL', async () => {
    await expectCode(
      feed.viewerDocuments(app, 'Bad Name', VIEWER_1, null, '', 100),
      'invalid_request'
    );
    await expectCode(feed.viewerVersions(app, 'board', VIEWER_1, 7, 'a/b', 100), 'invalid_request');
    await expectCode(feed.viewerVersions(app, 'board', VIEWER_1, -1, '', 100), 'invalid_request');
    await expectCode(feed.viewerVersions(app, 'board', VIEWER_1, 1.5, '', 100), 'invalid_request');
    await expect(feed.viewerDocuments(app, 'board', 0, null, '', 100)).rejects.toThrow(
      'doc-store: malformed user id'
    );
  });

  it('every statement it sent carried the bound app and the production namespace', () => {
    const VIEWER_SQL = [
      'SELECT d.key, d.version, d.seq\n',
      'SELECT d.key, d.data, d.version, d.seq, d.created_at',
    ];
    const sent = h.statements.filter(
      (s) => VIEWER_SQL.some((f) => s.sql.includes(f)) && s.sql.includes("d.author_kind = 'user'")
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((s) => s.ns))).toEqual(new Set([NS_PROD]));
    expect(h.violations).toEqual([]);
  });
});
