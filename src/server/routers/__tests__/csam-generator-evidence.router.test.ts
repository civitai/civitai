import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EvidenceService from '~/server/services/generator-evidence/generator-evidence.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Who may preserve and approve generator evidence. Ids are invented. */

const {
  preserveGeneratorEvidence,
  approveGeneratorEvidenceReport,
  getEvidenceTriggers,
  getEvidenceWorkflows,
  getGeneratorEvidenceReport,
  recopyGeneratorEvidenceFile,
  excludeGeneratorEvidenceFile,
} = vi.hoisted(() => ({
  preserveGeneratorEvidence: vi.fn(async () => ({ reportId: 1, refused: [], counts: {} })),
  approveGeneratorEvidenceReport: vi.fn(async () => ({ approved: true })),
  getEvidenceTriggers: vi.fn(async () => []),
  getEvidenceWorkflows: vi.fn(async () => ({ items: [] })),
  getGeneratorEvidenceReport: vi.fn(async () => null),
  recopyGeneratorEvidenceFile: vi.fn(async () => ({ status: 'preserved' })),
  excludeGeneratorEvidenceFile: vi.fn(async () => ({ version: 'v' })),
}));
vi.mock(
  '~/server/services/generator-evidence/generator-evidence.service',
  async (importOriginal) => ({
    ...(await importOriginal<typeof EvidenceService>()),
    preserveGeneratorEvidence,
    approveGeneratorEvidenceReport,
    getEvidenceTriggers,
    getEvidenceWorkflows,
    getGeneratorEvidenceReport,
    recopyGeneratorEvidenceFile,
    excludeGeneratorEvidenceFile,
  })
);

const { csamRouter } = await import('~/server/routers/csam.router');

const caller = (user: Record<string, unknown> | undefined, csamReports: boolean) =>
  csamRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { trpcFlagGuardPerRequest: true, csamReports },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

const preserve = { userId: 7, workflowIds: ['7-20261101000000000000'], triggers: [] };
const approve = { userId: 7, reportId: 3, version: 'v' };
const file = { userId: 7, reportId: 3, blobId: 'OUTPUT000000001.png' };
const codeOf = (call: Promise<unknown>) =>
  call.then(
    () => 'ok',
    (e: { code?: string }) => e.code
  );

beforeEach(() => vi.clearAllMocks());

describe('generator evidence procedures', () => {
  it('refuse a member who is not a moderator', async () => {
    const member = caller({ id: 5, isModerator: false }, true);
    expect(await codeOf(member.preserveGeneratorEvidence(preserve))).toBe('FORBIDDEN');
    expect(await codeOf(member.approveGeneratorEvidence(approve))).toBe('FORBIDDEN');
    expect(preserveGeneratorEvidence).not.toHaveBeenCalled();
    expect(approveGeneratorEvidenceReport).not.toHaveBeenCalled();
  });

  it('refuse every read to a member, and to a moderator without CSAM reporting access', async () => {
    for (const refused of [
      caller({ id: 5, isModerator: false }, true),
      caller({ id: 5, isModerator: true }, false),
    ]) {
      expect(await codeOf(refused.getGeneratorEvidenceTriggers({ userId: 7 }))).toBe('FORBIDDEN');
      expect(await codeOf(refused.getGeneratorEvidenceWorkflows({ userId: 7 }))).toBe('FORBIDDEN');
      expect(await codeOf(refused.getGeneratorEvidenceReport({ userId: 7 }))).toBe('FORBIDDEN');
    }
    expect(getEvidenceTriggers).not.toHaveBeenCalled();
    expect(getEvidenceWorkflows).not.toHaveBeenCalled();
    expect(getGeneratorEvidenceReport).not.toHaveBeenCalled();
  });

  it('refuse a moderator without CSAM reporting access', async () => {
    const moderator = caller({ id: 5, isModerator: true }, false);
    expect(await codeOf(moderator.preserveGeneratorEvidence(preserve))).toBe('FORBIDDEN');
    expect(await codeOf(moderator.approveGeneratorEvidence(approve))).toBe('FORBIDDEN');
    expect(await codeOf(moderator.recopyGeneratorEvidenceFile(file))).toBe('FORBIDDEN');
    expect(
      await codeOf(moderator.excludeGeneratorEvidenceFile({ ...file, reason: 'damaged copy' }))
    ).toBe('FORBIDDEN');
    expect(preserveGeneratorEvidence).not.toHaveBeenCalled();
    expect(recopyGeneratorEvidenceFile).not.toHaveBeenCalled();
    expect(excludeGeneratorEvidenceFile).not.toHaveBeenCalled();
  });

  it('let a moderator with CSAM reporting access through, acting as that moderator', async () => {
    const moderator = caller({ id: 5, isModerator: true }, true);
    expect(await codeOf(moderator.preserveGeneratorEvidence(preserve))).toBe('ok');
    expect(preserveGeneratorEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, moderatorId: 5 })
    );
    expect(await codeOf(moderator.getGeneratorEvidenceTriggers({ userId: 7 }))).toBe('ok');
    expect(getEvidenceTriggers).toHaveBeenCalledWith(7);
    expect(await codeOf(moderator.getGeneratorEvidenceReport({ userId: 7 }))).toBe('ok');
    expect(getGeneratorEvidenceReport).toHaveBeenCalledWith(7, 5);
  });
});
