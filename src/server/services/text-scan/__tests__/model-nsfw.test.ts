import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const { entityChangesMock } = vi.hoisted(() => ({ entityChangesMock: vi.fn() }));

// Hand-listed, as in model-moderation.adapter.test.ts: each real module builds clients at load.
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = entityChangesMock;
  },
}));

const { applyModelNsfwTextScan } = await import('~/server/services/text-scan/actions/model-nsfw');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { createNotification } = await import('~/server/services/notification.service');

const args = (raised: boolean) => ({
  entityId: 1,
  workflowId: 'wf',
  outcome: {
    nsfw: { detectedLevel: NsfwLevel.X, declaredLevel: NsfwLevel.PG13, raised, reason: 'r' },
    triggeredLabels: raised ? ['nsfw' as const] : [],
    nsfwLevel: NsfwLevel.X,
  },
  subject: { fields: [], declared: {} },
});
const model = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'LoRA',
  nsfw: false,
  nsfwLevel: 1,
  lockedProperties: [],
  userId: 99,
  ...over,
});
const flipSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map((c: unknown[]) => (c[0] as readonly string[]).join('?'))
    .find((sql: string) => sql.includes('SET nsfw = TRUE'));

beforeEach(() => {
  vi.clearAllMocks();
  entityChangesMock.mockResolvedValue(undefined);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.model.findUnique.mockResolvedValue(model());
});

describe('applyModelNsfwTextScan', () => {
  it('flips and locks nsfw, attributes it to the text scan, and notifies the owner once', async () => {
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toContain('array_append(');
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    expect(entityChangesMock).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 99,
        type: 'text-scan-rating-raised',
        key: `text-scan-rating-raised-Model-1-${NsfwLevel.X}-wf`,
        details: expect.objectContaining({ url: '/models/1', title: 'LoRA' }),
      })
    );
  });

  it('is silent on redelivery: the model is now locked', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      model({ nsfw: true, nsfwLevel: 60, lockedProperties: ['nsfw'] })
    );
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('never overturns a moderator lock', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ lockedProperties: ['nsfw'] }));
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not notify when a lock landed between read and write', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await applyModelNsfwTextScan(args(true));
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each(['poi', 'minor'] as const)(
    'flips and returns the rating notice instead of sending it when the same scan detects %s',
    async (label) => {
      const base = args(true);
      const flag = { detected: true, declared: false, newlyDetected: true, reason: 'r' };
      const result = await applyModelNsfwTextScan({
        ...base,
        outcome: { ...base.outcome, [label]: label === 'poi' ? { ...flag, names: ['A'] } : flag },
      });
      expect(flipSql()).toContain('array_append(');
      expect(createNotification).not.toHaveBeenCalled();
      expect(result).toEqual({
        deferredRatingNotice: {
          entityType: 'Model',
          entityId: 1,
          userId: 99,
          level: NsfwLevel.X,
          title: 'LoRA',
          url: '/models/1',
          workflowId: 'wf',
        },
      });
    }
  );

  it('returns no deferred notice when it sent one or none was due', async () => {
    expect(await applyModelNsfwTextScan(args(true))).toEqual({ deferredRatingNotice: null });
    expect(await applyModelNsfwTextScan(args(false))).toEqual({ deferredRatingNotice: null });
  });

  it('does nothing when the verdict did not raise, or the model is gone', async () => {
    await applyModelNsfwTextScan(args(false));
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
