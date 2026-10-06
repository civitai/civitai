import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';

vi.mock('~/server/services/crucible-nsfw-escalation', () => ({
  applyCrucibleNsfwEscalation: vi.fn(),
}));

const { applyCrucibleTextScan, settleSkippedCrucibleScan } = await import(
  '~/server/services/text-scan/actions/crucible'
);
const { applyCrucibleNsfwEscalation } = await import('~/server/services/crucible-nsfw-escalation');

const args = (detectedLevel: number, raised = detectedLevel > 1) => ({
  entityId: 5,
  workflowId: 'wf',
  outcome: {
    nsfw: { detectedLevel, declaredLevel: 1, raised, reason: 'r' },
    triggeredLabels: [],
    nsfwLevel: detectedLevel,
  },
  subject: { fields: [], declared: { nsfwLevel: 1 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('applyCrucibleTextScan', () => {
  it.each([
    [NsfwLevel.PG13, false],
    [NsfwLevel.R, true],
    [NsfwLevel.XXX, true],
  ])(
    'detected %s escalates as isNsfw=%s, never cancelling a green crucible',
    async (lvl, isNsfw) => {
      await applyCrucibleTextScan(args(lvl) as never);
      expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
        entityId: 5,
        isNsfw,
        greenCancels: false,
      });
    }
  );

  it('stays NSFW on a rescan of already-raised text (detected R, not raised)', async () => {
    await applyCrucibleTextScan(args(NsfwLevel.R, false) as never);
    expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
      entityId: 5,
      isNsfw: true,
      greenCancels: false,
    });
  });

  it('ignores an outcome without nsfw', async () => {
    await applyCrucibleTextScan({
      ...args(4),
      outcome: { triggeredLabels: [], nsfwLevel: null },
    } as never);
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
  });
});

describe('settleSkippedCrucibleScan', () => {
  it('too-short settles as clean so the crucible leaves Pending', async () => {
    await settleSkippedCrucibleScan(5, 'too-short');
    expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
      entityId: 5,
      isNsfw: false,
      greenCancels: false,
    });
  });

  it('unchanged re-applies the stored verdict', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: NsfwLevel.R,
      result: { version: 1 },
    });
    await settleSkippedCrucibleScan(5, 'unchanged');
    expect(dbMock.dbWrite.entityModeration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId: { entityType: 'Crucible', entityId: 5 } },
      })
    );
    expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
      entityId: 5,
      isNsfw: true,
      greenCancels: false,
    });
  });

  it.each([
    ['a PG13 verdict', NsfwLevel.PG13],
    ['a verdict without a level, as PG', null],
  ])('unchanged re-applies %s as not NSFW', async (_, nsfwLevel) => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel,
      result: { version: 1 },
    });
    await settleSkippedCrucibleScan(5, 'unchanged');
    expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
      entityId: 5,
      isNsfw: false,
      greenCancels: false,
    });
  });

  it('unchanged with a verdict still Pending is logged, not settled', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Pending',
      nsfwLevel: null,
      result: { version: 1 },
    });
    await settleSkippedCrucibleScan(5, 'unchanged');
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        crucibleId: 5,
        reason: 'unchanged',
        message: 'crucible scan skipped; ingestion left Pending',
      })
    );
  });

  it.each(['missing', 'in-flight'] as const)('%s does nothing', async (reason) => {
    await settleSkippedCrucibleScan(5, reason);
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
  });

  it('unchanged without a text-scan verdict is logged, not settled', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: NsfwLevel.R,
      result: {},
    });
    await settleSkippedCrucibleScan(5, 'unchanged');
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ crucibleId: 5, reason: 'unchanged' })
    );
  });

  it.each(['missing-prompt', 'no-profile'] as const)(
    '%s is logged, not settled',
    async (reason) => {
      await settleSkippedCrucibleScan(5, reason);
      expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ crucibleId: 5, reason })
      );
    }
  );
});
