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

const args = (detectedLevel: number) => ({
  entityId: 5,
  workflowId: 'wf',
  outcome: {
    nsfw: { detectedLevel, declaredLevel: 1, raised: detectedLevel > 1, reason: 'r' },
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
    expect(applyCrucibleNsfwEscalation).toHaveBeenCalledWith({
      entityId: 5,
      isNsfw: true,
      greenCancels: false,
    });
  });

  it.each(['missing', 'in-flight'] as const)('%s does nothing', async (reason) => {
    await settleSkippedCrucibleScan(5, reason);
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
  });

  it('missing-prompt is logged, not settled', async () => {
    await settleSkippedCrucibleScan(5, 'missing-prompt');
    expect(applyCrucibleNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ crucibleId: 5 }));
  });
});
