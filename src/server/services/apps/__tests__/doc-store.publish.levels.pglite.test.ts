import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore, type DocStore } from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD, PREFS } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Server-side publish under content levels (`DocStoreContext.levels`, `doc-levels.ts`): every copy
 * a publish creates or updates goes through the same "mark pending" step a shared put does
 * (`markRatingPending`), so it reads as pending — hidden from every other viewer, visible to its
 * author — until it is rated again. A copy the publish leaves unchanged keeps its rating. Real
 * migrations (content-level columns included) on PGlite, RLS on, as `appdata_rw`.
 *
 * Levels are NsfwLevel bits. The viewer level (31) admits every browsable level, so a hidden
 * copy is hidden by its rating STATUS, never by its level.
 */

const AUTHOR = 6101;
const OTHER = 6202;
const ALL = 31;

const gated = (c: DocStoreContext): DocStoreContext => ({
  ...c,
  levels: { viewerLevel: ALL, domainLevel: ALL },
});

async function stored(h: Harness, app: string, coll: DocCollection, key: string) {
  const [row] = await h.raw(
    `SELECT d.level, d.rating_status FROM appdata.doc d
     WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`,
    [app, NS_PROD, coll.name, key]
  );
  return row;
}

/** Rate a copy directly (superuser), against its current version, as the rater would. */
async function rate(h: Harness, app: string, key: string, level: number) {
  await h.raw(
    `UPDATE appdata.doc d SET level = $5, rating_status = 'rated', rated_at = now(),
       rated_version = d.version
     WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`,
    [app, NS_PROD, BOARD.name, key, level]
  );
}

let h: Harness;
let store: DocStore;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true, docLevels: true });
  store = createDocStore({ db: h.db });
});
afterAll(async () => {
  expect(h.violations).toEqual([]);
  await h?.close();
});

async function publish(c: DocStoreContext, keys: string[]) {
  const preview = await store.previewPublish(c, PREFS, BOARD, keys);
  return store.publishCopies(c, PREFS, BOARD, {
    keys,
    checked: new Map(preview.flatMap((e) => (e.source ? [[e.key, e.source.hash]] : []))),
  });
}

describe('publish with content levels on', () => {
  it('a new copy reads pending: hidden from another viewer, visible to its author', async () => {
    const app = freshApp('PUBLVL');
    const author = gated(ctx(app, NS_PROD, AUTHOR));
    const other = gated(ctx(app, NS_PROD, OTHER));
    await store.put(author, PREFS, 'c1', { t: 'clip one' });
    expect((await publish(author, ['c1'])).created).toEqual(['c1']);

    expect(await stored(h, app, BOARD, 'c1')).toEqual({ level: null, rating_status: 'pending' });
    expect(await store.get(other, BOARD, 'c1')).toBeNull();
    expect((await store.get(author, BOARD, 'c1'))?.rating).toEqual({
      level: null,
      status: 'pending',
    });
  });

  it('an unchanged copy keeps its rating; a changed one is pending again', async () => {
    const app = freshApp('PUBLVL');
    const author = gated(ctx(app, NS_PROD, AUTHOR));
    const other = gated(ctx(app, NS_PROD, OTHER));
    await store.put(author, PREFS, 'k1', { t: 'stays' });
    await store.put(author, PREFS, 'k2', { t: 'before' });
    await publish(author, ['k1', 'k2']);
    await rate(h, app, 'k1', 2);
    await rate(h, app, 'k2', 4);
    expect((await store.get(other, BOARD, 'k2'))?.key).toBe('k2');

    await store.put(author, PREFS, 'k2', { t: 'after' });
    const r = await publish(author, ['k1', 'k2']);
    expect([r.unchanged, r.updated]).toEqual([['k1'], ['k2']]);

    // Unchanged: still rated at 2 (PG-13), and another viewer still reads it.
    expect(await stored(h, app, BOARD, 'k1')).toEqual({ level: 2, rating_status: 'rated' });
    expect((await store.get(other, BOARD, 'k1'))?.key).toBe('k1');
    // Updated: the R rating is cleared and the copy waits to be rated again.
    expect(await stored(h, app, BOARD, 'k2')).toEqual({ level: null, rating_status: 'pending' });
    expect(await store.get(other, BOARD, 'k2')).toBeNull();
    expect((await store.get(author, BOARD, 'k2'))?.data).toEqual({ t: 'after' });
  });

  it('levels OFF: a publish leaves the rating columns untouched (INVARIANT GUARD)', async () => {
    const app = freshApp('PUBLVLOFF');
    const author = ctx(app, NS_PROD, AUTHOR);
    await store.put(author, PREFS, 'o1', { t: 'x' });
    await publish(author, ['o1']);
    expect(await stored(h, app, BOARD, 'o1')).toEqual({ level: null, rating_status: null });
  });
});
