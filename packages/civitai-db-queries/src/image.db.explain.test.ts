import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteImageForUser,
  deleteImageReactionForUser,
  updateImage,
  updateImageMany,
} from './image.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` (so writes compile but never execute), then EXPLAIN the compiled
// SQL against the live schema. Validates that every ported query's columns/joins/types/enums resolve. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('image queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  const simpleDeletes: Array<[string, () => Promise<unknown>]> = [
    ['deleteImageReactionForUser', () => deleteImageReactionForUser(h.db, -1)],
    ['deleteImageForUser', () => deleteImageForUser(h.db, -1)],
  ];

  it.each(simpleDeletes)('%s plans', async (_name, fn) => {
    await fn();
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateImage plans (write, not executed)', async () => {
    await updateImage(h.db, { id: -1, needsReview: 'appeal' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateImageMany plans the bulk update (write, not executed)', async () => {
    await updateImageMany(h.db, { ids: [-1, -2], needsReview: 'csam' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
