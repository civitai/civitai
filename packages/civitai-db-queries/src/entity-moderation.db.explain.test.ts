import { afterAll, describe, expect, it } from 'vitest';
import {
  getEntityModerationWithImageNsfwLevel,
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
  upsertEntityModerationPending,
} from './entity-moderation.db';
import { explainHarness } from './test/harness';

const h = explainHarness();

describe.skipIf(!h.hasDb)('entity-moderation queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('upsertEntityModerationPending plans (write, not executed)', async () => {
    await upsertEntityModerationPending(h.db, {
      entityType: 'article',
      entityId: -1,
      workflowId: 'wf-explain',
      contentHash: 'hash',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('recordEntityModerationSuccess plans (write, not executed)', async () => {
    await recordEntityModerationSuccess(h.db, {
      entityType: 'article',
      entityId: -1,
      workflowId: 'wf-explain',
      blocked: false,
      triggeredLabels: ['x'],
      result: { blocked: false },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('recordEntityModerationFailure plans (write, not executed)', async () => {
    await recordEntityModerationFailure(h.db, {
      entityType: 'article',
      entityId: -1,
      workflowId: 'wf-explain',
      status: 'Failed',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getEntityModerationWithImageNsfwLevel plans against the real schema', async () => {
    await getEntityModerationWithImageNsfwLevel(h.db, { entityType: 'article', entityId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
