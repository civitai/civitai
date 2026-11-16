import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { createRealPgHarness, REAL_PG_URL } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import { assertUsageConsistent, ctx, decl, freshApp, NS_PROD } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Server-side publish (`publishCopies`) against a REAL Postgres, one connection per store call, so
 * two publishes genuinely race. PGlite is a single session and cannot show this. CI's unit job
 * provides the server (`doc-store.pg.test.ts` fails CI when it does not), so the skip below only
 * applies to a local run without `APPDATA_TEST_DATABASE_URL`.
 */

const DRAFTS: DocCollection = { name: 'drafts', config: decl({ visibility: 'private' }) };
const CLIPS: DocCollection = {
  name: 'clips',
  config: decl({ visibility: 'shared', write: 'own', indexes: { char: 'string' } }),
};
const OWNER = 9301;

describe.skipIf(!REAL_PG_URL)('concurrent publishes of the same set (Postgres)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createRealPgHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('both succeed; every copy is written exactly once, and usage stays consistent', async () => {
    const store = createDocStore({ db: h.db });
    const app = freshApp('publishrace');
    const c = ctx(app, NS_PROD, OWNER);
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    for (const k of keys) await store.put(c, DRAFTS, k, { char: 'A', k });
    const preview = await store.previewPublish(c, DRAFTS, CLIPS, keys);
    const checked = new Map(preview.map((e) => [e.key, e.source?.hash ?? '']));

    const [r1, r2] = await Promise.all([
      store.publishCopies(c, DRAFTS, CLIPS, { keys, checked }),
      store.publishCopies(c, DRAFTS, CLIPS, { keys, checked }),
    ]);
    // One of them wrote all six; the other found them unchanged.
    expect([r1.created, r2.created].map((x) => x.length).sort()).toEqual([0, 6]);
    expect([r1.unchanged, r2.unchanged].map((x) => x.length).sort()).toEqual([0, 6]);
    const rows = await h.raw(
      `SELECT key, version FROM appdata.doc WHERE app_id = $1 AND ns = $2 AND coll = 'clips'
         AND scope_uid = 0 ORDER BY key`,
      [app, NS_PROD]
    );
    expect(rows.map((r) => [r.key, Number(r.version)])).toEqual(keys.map((k) => [k, 1]));
    const usage = await h.raw(
      `SELECT docs FROM appdata.usage_user WHERE app_id = $1 AND ns = $2 AND user_id = $3`,
      [app, NS_PROD, OWNER]
    );
    expect(Number(usage[0].docs)).toBe(12);
    await assertUsageConsistent(h, app, NS_PROD);
  });
});
