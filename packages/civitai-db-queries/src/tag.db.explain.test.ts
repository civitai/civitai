import { afterAll, describe, expect, it } from 'vitest';
import { explainHarness } from './test/harness';
import { createTag, getTagById, upsertTagsByName } from './tag.db';

const h = explainHarness();

afterAll(() => h.destroy());

// DB-backed tier: EXPLAIN each tag query against the live schema (no execution). Skips when no DB is reachable.
describe.skipIf(!h.hasDb)('tag.db queries EXPLAIN against the real schema', () => {
  it('getTagById plans', async () => {
    await getTagById(h.db, 1);
    expect(await h.explainLast()).toBeTruthy();
  });

  it('createTag plans (write, not executed)', async () => {
    await createTag(h.db, { name: 'x', target: ['Model'], nsfw: 'None' }).catch(() => {});
    expect(await h.explainLast()).toBeTruthy();
  });

  it('upsertTagsByName plans (batch insert + id lookup)', async () => {
    await upsertTagsByName(h.db, ['x', 'y'], ['Model']);
    expect((await h.explainAll()).length).toBeGreaterThan(0);
  });
});
