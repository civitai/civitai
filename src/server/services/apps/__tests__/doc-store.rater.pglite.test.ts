import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreMaintenance,
  createDocStoreModeration,
  createDocStoreRater,
  type DocStore,
  type DocStoreFeed,
  type DocStoreRater,
} from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD, PREFS, TALLIES } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The RATER's store operations (content levels, build 3): which shared documents need a rating
 * (`listUnrated`), and recording one (`applyRating`) only for the revision the rater read. Real
 * migrations (the content-level columns included) on PGlite, row-level security ON, as
 * `appdata_rw`; the harness's runtime isolation recorder checks every statement.
 *
 * Levels are NsfwLevel bits (PG 1, PG-13 2, R 4, X 8, XXX 16, Blocked 32). Every rating applied
 * here differs from the viewer level that reads it, and from any other level in the same case.
 */

const AUTHOR = 6101;
const OTHER = 6202;

const gated = (c: DocStoreContext, viewerLevel: number, domainLevel = viewerLevel) => ({
  ...c,
  levels: { viewerLevel, domainLevel },
});

let h: Harness;
let store: DocStore;
let rater: DocStoreRater;
let feed: DocStoreFeed;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true, docLevels: true });
  store = createDocStore({ db: h.db });
  rater = createDocStoreRater({ db: h.db });
  feed = createDocStoreFeed({ db: h.db });
});
afterAll(async () => {
  expect(h.violations).toEqual([]);
  await h?.close();
});

const keysOf = (docs: { key: string }[]) => docs.map((d) => d.key);

async function unrated(app: string, coll: DocCollection = BOARD, afterSeq = 0, limit = 50) {
  return rater.listUnrated(app, NS_PROD, coll.name, { afterSeq, limit });
}

async function stored(app: string, key: string) {
  const [row] = await h.raw(
    `SELECT d.level, d.rating_status, d.rated_version, d.version, d.seq::int AS seq,
       d.rated_at IS NOT NULL AS rated
     FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = 'board' AND d.key = $3`,
    [app, NS_PROD, key]
  );
  return row;
}

describe('listUnrated', () => {
  it('lists never-rated, pending and stale-rated shared documents, oldest change first; skips rated, private, counter and hidden ones', async () => {
    const app = freshApp('RTLIST');
    const plain = ctx(app, NS_PROD, AUTHOR);
    const on = gated(plain, 31);
    await store.put(plain, BOARD, 'never', { t: 'written while levels were off' });
    await store.put(on, BOARD, 'pending', { t: 'written while levels were on' });
    await store.put(plain, BOARD, 'rated', { t: 'rated for this version' });
    await store.put(plain, BOARD, 'stale', { t: 'rated, then edited' });
    await store.put(plain, BOARD, 'hidden', { t: 'hidden by a moderator' });
    await store.put(plain, PREFS, 'private', { theme: 'moss' });
    await store.increment(plain, TALLIES, 'counted', 'plays', 1);

    for (const key of ['rated', 'stale']) {
      const [doc] = (await unrated(app)).filter((d) => d.key === key);
      expect(
        (await rater.applyRating(app, NS_PROD, BOARD.name, key, { seq: doc.seq, level: 2 })).applied
      ).toBe(true);
    }
    await store.put(plain, BOARD, 'stale', { t: 'edited after the rating' });
    await createDocStoreModeration({ db: h.db }).setHidden(
      app,
      NS_PROD,
      BOARD.name,
      'hidden',
      true,
      77
    );

    const docs = await unrated(app);
    expect(keysOf(docs)).toEqual(['never', 'pending', 'stale']);
    // Oldest change first, and each read carries what a rating is bound to.
    expect(docs.map((d) => d.seq)).toEqual([...docs.map((d) => d.seq)].sort((a, b) => a - b));
    expect(docs[0]).toMatchObject({
      key: 'never',
      data: { t: 'written while levels were off' },
      version: 1,
    });
    expect(docs[2]).toMatchObject({ key: 'stale', version: 2 });
    // Counter-only and private collections list nothing.
    expect(await unrated(app, TALLIES)).toEqual([]);
    expect(await unrated(app, PREFS)).toEqual([]);
  });

  it('pages by the seq cursor and the limit', async () => {
    const app = freshApp('RTPAGE');
    const plain = ctx(app, NS_PROD, AUTHOR);
    for (const key of ['a', 'b', 'c']) await store.put(plain, BOARD, key, { t: key });
    const first = await unrated(app, BOARD, 0, 2);
    expect(keysOf(first)).toEqual(['a', 'b']);
    expect(keysOf(await unrated(app, BOARD, first[1].seq, 2))).toEqual(['c']);
  });

  it('stays inside its app: another app’s documents are never listed', async () => {
    const mine = freshApp('RTMINE');
    const theirs = freshApp('RTTHEIRS');
    await store.put(ctx(theirs, NS_PROD, AUTHOR), BOARD, 'other-app', { t: 'x' });
    expect(await unrated(mine)).toEqual([]);
  });
});

describe('applyRating', () => {
  it('🔴 records the level for the current version, gives the document the next seq, and readers follow it', async () => {
    const app = freshApp('RTAPPLY');
    const author = gated(ctx(app, NS_PROD, AUTHOR), 31);
    await store.put(author, BOARD, 'r1', { t: 'v1' });
    await store.put(author, BOARD, 'r1', { t: 'v2' });
    const [doc] = await unrated(app);
    const headBefore = await feed.feedHead(app);

    const out = await rater.applyRating(app, NS_PROD, BOARD.name, 'r1', { seq: doc.seq, level: 4 });
    expect(out).toEqual({ applied: true, seq: headBefore + 1, currentLevel: 4 });
    expect(await stored(app, 'r1')).toEqual({
      level: 4,
      rating_status: 'rated',
      rated_version: 2,
      version: 2,
      seq: headBefore + 1,
      rated: true,
    });
    expect(await feed.feedHead(app)).toBe(headBefore + 1);
    // R (4): a viewer whose level holds R sees it, one whose level does not, does not.
    expect((await store.get(gated(ctx(app, NS_PROD, OTHER), 7), BOARD, 'r1'))?.rating).toEqual({
      level: 4,
      status: 'rated',
    });
    expect(await store.get(gated(ctx(app, NS_PROD, OTHER), 3), BOARD, 'r1')).toBeNull();
    // Rated now: no longer listed.
    expect(await unrated(app)).toEqual([]);
  });

  it('🔴 drops a rating for a revision the document has left: an edit, and a delete then re-create', async () => {
    const app = freshApp('RTSTALE');
    const plain = ctx(app, NS_PROD, AUTHOR);
    await store.put(plain, BOARD, 'e1', { t: 'scanned text' });
    await store.put(plain, BOARD, 'd1', { t: 'scanned text' });
    const [e1, d1] = await unrated(app);

    await store.put(plain, BOARD, 'e1', { t: 'edited while it was being scanned' });
    expect(
      await rater.applyRating(app, NS_PROD, BOARD.name, 'e1', { seq: e1.seq, level: 1 })
    ).toEqual({
      applied: false,
      reason: 'changed',
    });
    // Re-created at version 1 again: only the seq can tell it is not the document that was read.
    await store.delete(plain, BOARD, 'd1');
    await store.put(plain, BOARD, 'd1', { t: 'different text' });
    expect((await stored(app, 'd1')).version).toBe(1);
    expect(
      await rater.applyRating(app, NS_PROD, BOARD.name, 'd1', { seq: d1.seq, level: 1 })
    ).toEqual({
      applied: false,
      reason: 'changed',
    });
    for (const key of ['e1', 'd1']) {
      expect((await stored(app, key)).rating_status).toBeNull();
    }
    expect(keysOf(await unrated(app))).toEqual(['e1', 'd1']);
  });

  it('refuses a gone, hidden or counter document, and writes nothing', async () => {
    const app = freshApp('RTREFUSE');
    const plain = ctx(app, NS_PROD, AUTHOR);
    await store.put(plain, BOARD, 'h1', { t: 'x' });
    const [h1] = await unrated(app);
    await createDocStoreModeration({ db: h.db }).setHidden(
      app,
      NS_PROD,
      BOARD.name,
      'h1',
      true,
      77
    );
    const hiddenSeq = (await stored(app, 'h1')).seq;
    expect(
      await rater.applyRating(app, NS_PROD, BOARD.name, 'h1', { seq: hiddenSeq, level: 2 })
    ).toEqual({
      applied: false,
      reason: 'hidden',
    });
    expect(h1.seq).toBe(hiddenSeq);
    expect(await rater.applyRating(app, NS_PROD, BOARD.name, 'nope', { seq: 1, level: 2 })).toEqual(
      {
        applied: false,
        reason: 'gone',
      }
    );
    await store.increment(plain, TALLIES, 'c1', 'plays', 1);
    const [counter] = await h.raw(
      `SELECT d.seq FROM appdata.doc d WHERE d.app_id = $1 AND d.coll = 'tallies' AND d.key = 'c1'`,
      [app]
    );
    expect(
      await rater.applyRating(app, NS_PROD, TALLIES.name, 'c1', {
        seq: Number(counter.seq),
        level: 2,
      })
    ).toEqual({ applied: false, reason: 'counter' });
    expect((await stored(app, 'h1')).rating_status).toBeNull();
  });

  it('a moderator override for the current version still wins over a new rating', async () => {
    const app = freshApp('RTOVR');
    const plain = ctx(app, NS_PROD, AUTHOR);
    await store.put(plain, BOARD, 'o1', { t: 'x' });
    await h.raw(
      `UPDATE appdata.doc d SET override_level = 16, override_version = d.version
       WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'board' AND d.key = 'o1'`,
      [app]
    );
    const [doc] = await unrated(app);
    const out = await rater.applyRating(app, NS_PROD, BOARD.name, 'o1', { seq: doc.seq, level: 2 });
    expect(out).toMatchObject({ applied: true, currentLevel: 16 });
  });

  it.each([0, 3, 64, -1, 1.5])(
    'refuses a level that is not one NsfwLevel bit: %s',
    async (level) => {
      const app = freshApp('RTBITS');
      await expect(
        rater.applyRating(app, NS_PROD, BOARD.name, 'k', { seq: 1, level })
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
  );

  it('the maintenance object is unaffected: its schema-migration rewrite still makes a rated document unrated again', async () => {
    const app = freshApp('RTMIG');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'm1', { t: 'before' });
    const [doc] = await unrated(app);
    await rater.applyRating(app, NS_PROD, BOARD.name, 'm1', { seq: doc.seq, level: 2 });
    expect(await unrated(app)).toEqual([]);
    await createDocStoreMaintenance({ db: h.db }).migrateDocuments(app, BOARD, (data) => ({
      ...data,
      t: 'after',
    }));
    expect(keysOf(await unrated(app))).toEqual(['m1']);
  });
});
