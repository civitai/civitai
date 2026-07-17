import { afterAll, describe, expect, it } from 'vitest';
import {
  createEntityAppeal,
  getAppealById,
  getAppealCount,
  getAppealImageEntity,
  getPendingAppealsForResolve,
  getRecentAppealsByUserId,
  setAppealStatusMany,
  setImageAppealStatus,
} from './appeal.db';
import { explainHarness } from './test/harness';

const h = explainHarness();

describe.skipIf(!h.hasDb)('appeals queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getRecentAppealsByUserId plans', async () => {
    await getRecentAppealsByUserId(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getAppealCount plans', async () => {
    await getAppealCount(h.db, {
      userId: -1,
      status: ['Pending', 'Rejected'],
      startDate: new Date('2026-01-01'),
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getAppealById plans', async () => {
    await getAppealById(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getAppealImageEntity plans', async () => {
    await getAppealImageEntity(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getPendingAppealsForResolve plans', async () => {
    await getPendingAppealsForResolve(h.db, { ids: [-1, -2], entityType: 'Image' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('createEntityAppeal plans (write, not executed)', async () => {
    await createEntityAppeal(h.db, {
      entityId: -1,
      entityType: 'Image',
      message: 'explain',
      userId: -1,
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealStatus plans, no resolvedMessage (write, not executed)', async () => {
    await setImageAppealStatus(h.db, { imageId: -1, status: 'Approved', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealStatus plans, with resolvedMessage (write, not executed)', async () => {
    await setImageAppealStatus(h.db, {
      imageId: -1,
      status: 'Rejected',
      userId: -1,
      resolvedMessage: null,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setAppealStatusMany plans (write, not executed)', async () => {
    await setAppealStatusMany(h.db, {
      ids: [-1, -2],
      status: 'Approved',
      userId: -1,
      resolvedMessage: 'x',
      internalNotes: 'y',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
