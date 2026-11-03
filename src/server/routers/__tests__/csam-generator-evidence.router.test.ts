import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EvidenceService from '~/server/services/generator-evidence/generator-evidence.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Who may preserve and approve generator evidence. Ids are invented. */

const { preserveGeneratorEvidence, approveGeneratorEvidenceReport } = vi.hoisted(() => ({
  preserveGeneratorEvidence: vi.fn(async () => ({ reportId: 1, refused: [], counts: {} })),
  approveGeneratorEvidenceReport: vi.fn(async () => ({ approved: true })),
}));
vi.mock(
  '~/server/services/generator-evidence/generator-evidence.service',
  async (importOriginal) => ({
    ...(await importOriginal<typeof EvidenceService>()),
    preserveGeneratorEvidence,
    approveGeneratorEvidenceReport,
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
const approve = { userId: 7, reportId: 3 };
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

  it('refuse a moderator without CSAM reporting access', async () => {
    const moderator = caller({ id: 5, isModerator: true }, false);
    expect(await codeOf(moderator.preserveGeneratorEvidence(preserve))).toBe('FORBIDDEN');
    expect(await codeOf(moderator.approveGeneratorEvidence(approve))).toBe('FORBIDDEN');
    expect(preserveGeneratorEvidence).not.toHaveBeenCalled();
  });

  it('let a moderator with CSAM reporting access through, acting as that moderator', async () => {
    const moderator = caller({ id: 5, isModerator: true }, true);
    expect(await codeOf(moderator.preserveGeneratorEvidence(preserve))).toBe('ok');
    expect(preserveGeneratorEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, moderatorId: 5 })
    );
  });
});
