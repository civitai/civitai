import { afterAll, describe, expect, it } from 'vitest';
import {
  clearModelPublishedPosts,
  getFlaggedModels,
  getModelForVersion,
  resolveFlaggedModel,
  setModelUnpublished,
  unpublishModelVersions,
  upsertModelFlag,
} from './model-flag.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query/statement against the live schema. Queries run on the
// DummyDriver (never executed), and only the captured compiled SQL is EXPLAINed — so a column/type/enum
// mismatch against the real ModelFlag/Model/ModelVersion/Post tables fails here. Skips when no DB URL.
const h = explainHarness();

describe.skipIf(!h.hasDb)('model-flag queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('upsertModelFlag plans (write, not executed)', async () => {
    await upsertModelFlag(h.db, {
      modelId: -1,
      scanResult: {
        poi: true,
        nsfw: false,
        minor: false,
        triggerWords: false,
        poiName: false,
        sfwOnly: false,
      },
      details: { llm: 'x' },
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getFlaggedModels (items + count) plans against the real schema', async () => {
    h.queries.length = 0;
    await getFlaggedModels(h.db, { take: 20, skip: 0, sort: [{ id: 'createdAt', desc: true }] });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('resolveFlaggedModel plans (write, not executed)', async () => {
    await resolveFlaggedModel(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModelForVersion plans against the real schema', async () => {
    await getModelForVersion(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setModelUnpublished plans (write, not executed)', async () => {
    await setModelUnpublished(h.db, {
      id: -1,
      status: 'UnpublishedViolation',
      meta: { unpublishedBy: -1 },
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModelVersions plans (write, not executed)', async () => {
    await unpublishModelVersions(h.db, { modelId: -1, meta: { unpublishedBy: -1 } });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('clearModelPublishedPosts plans (write, not executed)', async () => {
    await clearModelPublishedPosts(h.db, {
      modelId: -1,
      userId: -1,
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
