import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreLookup,
  createDocStoreMaintenance,
  type DocStore,
  type DocStoreFeed,
  type DocStoreLookup,
} from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { readFileSync } from 'fs';
import {
  createPgliteHarness,
  MIGRATION_DOC_LEVELS_DOWN,
  MIGRATION_DOC_LEVELS_UP,
  type Harness,
} from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD, PREFS } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Content levels of shared documents (`app-blocks-shared-doc-levels`, `doc-levels.ts`) at the
 * store: the levels gate rides on the context (`DocStoreContext.levels`), and every read path that
 * returns shared documents to someone other than their author applies `sharedDocLevelVisible`.
 * Real migrations (the content-level columns included) on PGlite, row-level security ON, as
 * `appdata_rw`; the harness's runtime isolation recorder checks every statement.
 *
 * Levels are NsfwLevel bits (PG 1, PG-13 2, R 4, X 8, XXX 16, Blocked 32). Each case's document
 * level and viewer level are chosen so the expected answer differs from what any one hardcoded
 * level or mask would give: a viewer level is never a single bit equal to a document's level, and
 * the documents in one case carry pairwise distinct levels.
 */

const AUTHOR = 5101;
const OTHER = 5202;

/**
 * `viewerLevel` is the reader's own browsing level (token ceiling ∩ their setting); `domainLevel`
 * the token's domain ceiling alone, which caps an author's own RATED documents. Defaults to the
 * viewer level where a case does not care.
 */
const gated = (
  c: DocStoreContext,
  viewerLevel: number,
  domainLevel: number = viewerLevel
): DocStoreContext => ({
  ...c,
  levels: { viewerLevel, domainLevel },
});
// Domain ceilings: a red-capable host admits every browsable level; the SFW host PG and PG-13.
const RED = 31;
const COM = 3;

/**
 * Set a document's rating columns directly (superuser): the rater (build 3) does not exist yet. A
 * rating and an override are recorded against the document's CURRENT version, as the rater and
 * the override will record them.
 */
async function rate(
  h: Harness,
  app: string,
  coll: DocCollection,
  key: string,
  r: { level?: number | null; status?: string | null; override?: number | null }
) {
  await h.raw(
    `UPDATE appdata.doc d SET level = $5, rating_status = $6, override_level = $7,
       rated_at = CASE WHEN $5::int IS NULL THEN NULL ELSE now() END,
       rated_version = CASE WHEN $5::int IS NULL THEN NULL ELSE d.version END,
       override_version = CASE WHEN $7::int IS NULL THEN NULL ELSE d.version END
     WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.key = $4`,
    [app, NS_PROD, coll.name, key, r.level ?? null, r.status ?? null, r.override ?? null]
  );
}

/** The rating columns as stored. */
async function stored(h: Harness, app: string, coll: DocCollection, key: string) {
  const [row] = await h.raw(
    `SELECT d.level, d.rating_status, d.override_level, d.rated_at IS NOT NULL AS rated
     FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.key = $4`,
    [app, NS_PROD, coll.name, key]
  );
  return row;
}

async function listKeys(store: DocStore, c: DocStoreContext, coll: DocCollection) {
  return (await store.list(c, coll)).items.map((d) => d.key).sort();
}

/** What every read path a block token reaches returns for `key`: get, getMany, list. */
async function readsOf(store: DocStore, c: DocStoreContext, coll: DocCollection, key: string) {
  return {
    get: (await store.get(c, coll, key))?.key ?? null,
    getMany: (await store.getMany(c, coll, [key]))[0]?.key ?? null,
    list: (await listKeys(store, c, coll)).includes(key) ? key : null,
  };
}
const seen = (key: string) => ({ get: key, getMany: key, list: key });
const unseen = { get: null, getMany: null, list: null };

let h: Harness;
let store: DocStore;
let feed: DocStoreFeed;
let lookup: DocStoreLookup;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true, docLevels: true });
  store = createDocStore({ db: h.db });
  feed = createDocStoreFeed({ db: h.db });
  lookup = createDocStoreLookup({ db: h.db });
});
afterAll(async () => {
  expect(h.violations).toEqual([]);
  await h?.close();
});

describe('levels OFF (no gate on the context)', () => {
  it('INVARIANT GUARD: a shared write leaves the rating columns untouched, and no read names them', async () => {
    const app = freshApp('LVLOFF');
    const from = h.statements.length;
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'hello' });
    expect(await stored(h, app, BOARD, 'b1')).toEqual({
      level: null,
      rating_status: null,
      override_level: null,
      rated: false,
    });
    // Rated far above anything: with levels off nothing reads it, so another viewer still does.
    await rate(h, app, BOARD, 'b1', { level: 16, status: 'rated' });
    const other = ctx(app, NS_PROD, OTHER);
    expect(await readsOf(store, other, BOARD, 'b1')).toEqual(seen('b1'));
    expect(await store.get(other, BOARD, 'b1')).not.toHaveProperty('rating');
    await lookup.findSharedByKey(app, [BOARD.name], 'b1');
    await feed.feedDocuments(app, BOARD.name, '', await feed.feedHead(app), 10);
    await feed.feedChanges(app, BOARD.name, 0, await feed.feedHead(app), 10);
    const sql = h.statements.slice(from).map((s) => s.sql);
    expect(sql.length).toBeGreaterThan(0);
    // Positive control for the pattern below: the store's own statements do match `d.data`.
    expect(sql.some((s) => /d\.data/.test(s))).toBe(true);
    expect(sql.filter((s) => /rating_status|override_level|\bd\.level\b/.test(s))).toEqual([]);
  });

  it('INVARIANT GUARD: an unrated (NULL) document is visible to everyone', async () => {
    const app = freshApp('LVLOFFNULL');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'n1', { t: 'x' });
    expect(await readsOf(store, ctx(app, NS_PROD, OTHER), BOARD, 'n1')).toEqual(seen('n1'));
  });
});

describe('levels ON', () => {
  it('a shared write marks the document pending and clears its level; the stale override no longer counts', async () => {
    const app = freshApp('LVLWRITE');
    const author = gated(ctx(app, NS_PROD, AUTHOR), 7);
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'w1', { t: 'v1' });
    await rate(h, app, BOARD, 'w1', { level: 4, status: 'overridden', override: 2 });
    const written = await store.put(author, BOARD, 'w1', { t: 'v2' });
    // The override was for the version before the edit: it no longer applies.
    expect(written.rating).toEqual({ level: null, status: 'pending' });
    expect(await stored(h, app, BOARD, 'w1')).toEqual({
      level: null,
      rating_status: 'pending',
      override_level: 2,
      rated: true,
    });
    const created = await store.create(author, BOARD, { t: 'new' });
    expect(created.rating).toEqual({ level: null, status: 'pending' });
    expect((await stored(h, app, BOARD, created.key)).rating_status).toBe('pending');
  });

  describe('🔴 a rating or override counts only for the version it was given for', () => {
    const COM_VIEWER = 3; // PG | PG-13

    it('an override down to PG, then an edit, then a rating of X: a com viewer does not see it', async () => {
      const app = freshApp('LVLVEROVR');
      const author = gated(ctx(app, NS_PROD, AUTHOR), 31, RED);
      await store.put(author, BOARD, 'v1', { t: 'first' });
      await rate(h, app, BOARD, 'v1', { level: 8, status: 'overridden', override: 1 });
      const other = gated(ctx(app, NS_PROD, OTHER), COM_VIEWER, COM);
      // Positive control: the override applies to the version it was given for.
      expect(await readsOf(store, other, BOARD, 'v1')).toEqual(seen('v1'));
      await store.put(author, BOARD, 'v1', { t: 'second, rewritten' });
      // The rater rates the NEW version X; the old override is still in its column.
      await h.raw(
        `UPDATE appdata.doc d SET level = 8, rating_status = 'rated', rated_at = now(),
           rated_version = d.version
         WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'board' AND d.key = 'v1'`,
        [app]
      );
      expect(await readsOf(store, other, BOARD, 'v1')).toEqual(unseen);
      expect((await store.get(author, BOARD, 'v1'))?.rating).toEqual({
        level: 8,
        status: 'rated',
      });
    });

    it('an edit while levels were off: once they are on, the document reads as pending', async () => {
      const app = freshApp('LVLVEROFF');
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'e1', { t: 'clean' });
      await rate(h, app, BOARD, 'e1', { level: 2, status: 'rated' });
      const other = gated(ctx(app, NS_PROD, OTHER), 31, RED);
      expect(await readsOf(store, other, BOARD, 'e1')).toEqual(seen('e1'));
      // Written with no levels on the context: nothing marks it pending.
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'e1', { t: 'something else' });
      expect((await stored(h, app, BOARD, 'e1')).rating_status).toBe('rated');
      expect(await readsOf(store, other, BOARD, 'e1')).toEqual(unseen);
      expect((await store.get(gated(ctx(app, NS_PROD, AUTHOR), 1), BOARD, 'e1'))?.rating).toEqual({
        level: null,
        status: 'pending',
      });
    });

    it('a schema-migration rewrite of the body: the document reads as pending', async () => {
      const app = freshApp('LVLVERMIG');
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'm1', { t: 'before' });
      await rate(h, app, BOARD, 'm1', { level: 2, status: 'rated' });
      const other = gated(ctx(app, NS_PROD, OTHER), 31, RED);
      expect(await readsOf(store, other, BOARD, 'm1')).toEqual(seen('m1'));
      const result = await createDocStoreMaintenance({ db: h.db }).migrateDocuments(
        app,
        BOARD,
        (data) => ({ ...data, t: 'after' })
      );
      expect(result.migrated).toBe(1);
      expect(await readsOf(store, other, BOARD, 'm1')).toEqual(unseen);
    });
  });

  it('a private write is never marked, and a private read is never gated', async () => {
    const app = freshApp('LVLPRIV');
    const me = gated(ctx(app, NS_PROD, AUTHOR), 1);
    await store.put(me, PREFS, 'p1', { theme: 'moss' });
    const [row] = await h.raw(
      `SELECT d.rating_status FROM appdata.doc d WHERE d.app_id = $1 AND d.key = 'p1'`,
      [app]
    );
    expect(row.rating_status).toBeNull();
    expect((await store.get(me, PREFS, 'p1'))?.data).toEqual({ theme: 'moss' });
  });

  it('🔴 a pending document is hidden from another viewer and visible to its author', async () => {
    const app = freshApp('LVLPEND');
    await store.put(gated(ctx(app, NS_PROD, AUTHOR), 31), BOARD, 'p1', { t: 'mine' });
    // Every browsable level: only the status can be what hides it.
    expect(await readsOf(store, gated(ctx(app, NS_PROD, OTHER), 31), BOARD, 'p1')).toEqual(unseen);
    expect(await readsOf(store, gated(ctx(app, NS_PROD, null), 31), BOARD, 'p1')).toEqual(unseen);
    const author = gated(ctx(app, NS_PROD, AUTHOR), 1);
    expect(await readsOf(store, author, BOARD, 'p1')).toEqual(seen('p1'));
    expect((await store.get(author, BOARD, 'p1'))?.rating).toEqual({
      level: null,
      status: 'pending',
    });
  });

  it('🔴 an unrated (NULL) document is hidden from another viewer and visible to its author', async () => {
    const app = freshApp('LVLNULL');
    // Written while levels were off: no status at all.
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'u1', { t: 'old' });
    expect(await readsOf(store, gated(ctx(app, NS_PROD, OTHER), 31), BOARD, 'u1')).toEqual(unseen);
    const author = gated(ctx(app, NS_PROD, AUTHOR), 3);
    expect(await readsOf(store, author, BOARD, 'u1')).toEqual(seen('u1'));
    expect((await store.get(author, BOARD, 'u1'))?.rating).toEqual({ level: null, status: null });
  });

  it('🔴 a rated document above the viewer’s level is hidden; one within it is shown', async () => {
    const app = freshApp('LVLRATED');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'r4', { t: 'r' });
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'r2', { t: 'pg13' });
    await rate(h, app, BOARD, 'r4', { level: 4, status: 'rated' });
    await rate(h, app, BOARD, 'r2', { level: 2, status: 'rated' });
    const sfw = gated(ctx(app, NS_PROD, OTHER), 3); // PG | PG-13
    const withR = gated(ctx(app, NS_PROD, OTHER), 5); // PG | R
    expect(await readsOf(store, sfw, BOARD, 'r4')).toEqual(unseen);
    expect(await readsOf(store, sfw, BOARD, 'r2')).toEqual(seen('r2'));
    expect(await readsOf(store, withR, BOARD, 'r4')).toEqual(seen('r4'));
    expect(await readsOf(store, withR, BOARD, 'r2')).toEqual(unseen);
    expect((await store.get(withR, BOARD, 'r4'))?.rating).toEqual({ level: 4, status: 'rated' });
  });

  it('🔴 an override wins over the rated level, in both directions', async () => {
    const app = freshApp('LVLOVR');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'down', { t: 'a' });
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'up', { t: 'b' });
    // Rated X, overridden down to PG-13.
    await rate(h, app, BOARD, 'down', { level: 8, status: 'overridden', override: 2 });
    // Rated PG, overridden up to XXX.
    await rate(h, app, BOARD, 'up', { level: 1, status: 'overridden', override: 16 });
    const sfw = gated(ctx(app, NS_PROD, OTHER), 3); // PG | PG-13
    expect(await readsOf(store, sfw, BOARD, 'down')).toEqual(seen('down'));
    expect(await readsOf(store, sfw, BOARD, 'up')).toEqual(unseen);
    const xOnly = gated(ctx(app, NS_PROD, OTHER), 8 | 4); // R | X
    expect(await readsOf(store, xOnly, BOARD, 'down')).toEqual(unseen);
    const withXxx = gated(ctx(app, NS_PROD, OTHER), 16 | 4); // R | XXX
    expect(await readsOf(store, withXxx, BOARD, 'up')).toEqual(seen('up'));
    expect((await store.get(sfw, BOARD, 'down'))?.rating).toEqual({
      level: 2,
      status: 'overridden',
    });
  });

  it('🔴 a Blocked (32) document is hidden from every viewer level, its author included', async () => {
    const app = freshApp('LVLBLOCK');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'bl', { t: 'x' });
    await rate(h, app, BOARD, 'bl', { level: 32, status: 'rated' });
    expect(await readsOf(store, gated(ctx(app, NS_PROD, OTHER), 31), BOARD, 'bl')).toEqual(unseen);
    expect(await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 31, RED), BOARD, 'bl')).toEqual(
      unseen
    );
  });

  describe('🔴 an author’s own documents: unrated ones always, rated ones within the DOMAIN ceiling', () => {
    it('their rated R (4) document shows on a red token and not on a com token', async () => {
      const app = freshApp('LVLOWNR');
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'own-r', { t: 'r' });
      await rate(h, app, BOARD, 'own-r', { level: 4, status: 'rated' });
      // Their own setting is PG only: the domain, not their setting, decides their own document.
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 1, RED), BOARD, 'own-r')
      ).toEqual(seen('own-r'));
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 1, COM), BOARD, 'own-r')
      ).toEqual(unseen);
    });

    it('an author whose own level excludes R still sees their rated R document on red', async () => {
      const app = freshApp('LVLOWNPG');
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'own-r2', { t: 'r' });
      await rate(h, app, BOARD, 'own-r2', { level: 4, status: 'rated' });
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 3, RED), BOARD, 'own-r2')
      ).toEqual(seen('own-r2'));
      // ...and another viewer at that same level does not.
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, OTHER), 3, RED), BOARD, 'own-r2')
      ).toEqual(unseen);
    });

    it('an override caps the author too: overridden up to X (8) is hidden from them on com', async () => {
      const app = freshApp('LVLOWNOVR');
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'own-o', { t: 'o' });
      await rate(h, app, BOARD, 'own-o', { level: 2, status: 'overridden', override: 8 });
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 31, COM), BOARD, 'own-o')
      ).toEqual(unseen);
      expect(
        await readsOf(store, gated(ctx(app, NS_PROD, AUTHOR), 1, RED), BOARD, 'own-o')
      ).toEqual(seen('own-o'));
    });

    it('their pending and unrated documents show at any domain', async () => {
      const app = freshApp('LVLOWNPEND');
      await store.put(gated(ctx(app, NS_PROD, AUTHOR), 1, 1), BOARD, 'own-p', { t: 'p' });
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'own-n', { t: 'n' });
      const author = gated(ctx(app, NS_PROD, AUTHOR), 1, 1);
      expect(await readsOf(store, author, BOARD, 'own-p')).toEqual(seen('own-p'));
      expect(await readsOf(store, author, BOARD, 'own-n')).toEqual(seen('own-n'));
    });
  });

  it('🔴 registry feed: a document the gate leaves out reads as hidden, and the full read omits it', async () => {
    const app = freshApp('LVLFEED');
    for (const k of ['f-ok', 'f-high', 'f-pend']) {
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, k, { k });
    }
    await rate(h, app, BOARD, 'f-ok', { level: 2, status: 'rated' });
    await rate(h, app, BOARD, 'f-high', { level: 8, status: 'rated' });
    await rate(h, app, BOARD, 'f-pend', { status: 'pending' });
    const head = await feed.feedHead(app);
    const levels = { viewerLevel: 3 | 4 }; // PG | PG-13 | R
    const changes = await feed.feedChanges(app, BOARD.name, 0, head, 10, levels);
    expect(Object.fromEntries(changes.docs.map((d) => [d.key, d.hidden]))).toEqual({
      'f-ok': false,
      'f-high': true,
      'f-pend': true,
    });
    const all = await feed.feedDocuments(app, BOARD.name, '', head, 10, levels);
    expect(all.map((d) => d.key)).toEqual(['f-ok']);
    // Off, the same reads are what they were.
    const ungated = await feed.feedChanges(app, BOARD.name, 0, head, 10);
    expect(ungated.docs.every((d) => d.hidden === false)).toBe(true);
    expect((await feed.feedDocuments(app, BOARD.name, '', head, 10)).map((d) => d.key)).toEqual([
      'f-high',
      'f-ok',
      'f-pend',
    ]);
  });

  it('🔴 server key lookup: level-blind `hidden`, and the rating for the card path to decide on', async () => {
    const app = freshApp('LVLLOOKUP');
    for (const k of ['k-rated', 'k-pend', 'k-null', 'k-over']) {
      await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, k, { k });
    }
    await rate(h, app, BOARD, 'k-rated', { level: 8, status: 'rated' });
    await rate(h, app, BOARD, 'k-pend', { status: 'pending' });
    await rate(h, app, BOARD, 'k-over', { level: 2, status: 'overridden', override: 16 });
    const found = async (key: string) =>
      (await lookup.findSharedByKey(app, [BOARD.name], key, { rating: true }))[0];
    expect(await found('k-rated')).toEqual({
      collection: BOARD.name,
      authorUid: AUTHOR,
      hidden: false,
      rating: { level: 8, status: 'rated' },
    });
    expect(await found('k-pend')).toMatchObject({
      hidden: false,
      rating: { level: null, status: 'pending' },
    });
    expect(await found('k-null')).toMatchObject({
      hidden: false,
      rating: { level: null, status: null },
    });
    // The override first.
    expect(await found('k-over')).toMatchObject({ rating: { level: 16, status: 'overridden' } });
    // Off: exactly what it was.
    expect((await lookup.findSharedByKey(app, [BOARD.name], 'k-pend'))[0]).toEqual({
      collection: BOARD.name,
      authorUid: AUTHOR,
      hidden: false,
    });
  });
});

describe('the content-level migration', () => {
  it('rolls back and re-applies cleanly: the down drops every column it added', async () => {
    const m = await createPgliteHarness({ rls: true, docLevels: true });
    try {
      const columns = async () =>
        (
          await m.raw(
            `SELECT a.attname FROM pg_catalog.pg_attribute a
               JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'appdata' AND c.relname = 'doc' AND NOT a.attisdropped
               AND a.attname IN ('level', 'rating_status', 'override_level', 'override_by',
                 'override_at', 'rated_at', 'rated_version', 'override_version', 'seq')
             ORDER BY a.attname`
          )
        ).map((r) => r.attname as string);
      const ALL = [
        'level',
        'override_at',
        'override_by',
        'override_level',
        'override_version',
        'rated_at',
        'rated_version',
        'rating_status',
        'seq',
      ];
      expect(await columns()).toEqual(ALL);
      await m.raw(readFileSync(MIGRATION_DOC_LEVELS_DOWN, 'utf8'));
      // `seq` is the positive control: the query still finds a column that was never dropped.
      expect(await columns()).toEqual(['seq']);
      // Re-applied, twice: idempotent, constraints included.
      await m.raw(readFileSync(MIGRATION_DOC_LEVELS_UP, 'utf8'));
      await m.raw(readFileSync(MIGRATION_DOC_LEVELS_UP, 'utf8'));
      expect(await columns()).toEqual(ALL);
      const constraints = await m.raw(
        `SELECT conname FROM pg_catalog.pg_constraint
         WHERE conrelid = 'appdata.doc'::regclass
           AND conname IN ('doc_level_bit', 'doc_override_level_bit', 'doc_rating_status')
         ORDER BY conname`
      );
      expect(constraints.map((r) => r.conname)).toEqual([
        'doc_level_bit',
        'doc_override_level_bit',
        'doc_rating_status',
      ]);
    } finally {
      await m.close();
    }
  });
});
