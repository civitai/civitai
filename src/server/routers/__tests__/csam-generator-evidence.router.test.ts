import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EvidenceService from '~/server/services/generator-evidence/generator-evidence.service';
import type * as CsamService from '~/server/services/csam.service';
import type * as UnconfirmedOpen from '~/server/services/csam-unconfirmed-open';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Who may preserve, approve and send CSAM evidence, and read the reports. Ids are invented. */

const {
  preserveGeneratorEvidence,
  approveGeneratorEvidenceReport,
  getEvidenceTriggers,
  getEvidenceWorkflows,
  getGeneratorEvidenceReport,
  recopyGeneratorEvidenceFile,
  excludeGeneratorEvidenceFile,
  clearUnconfirmedOpens,
  getCsamReportsPaged,
  getCsamReportStats,
} = vi.hoisted(() => ({
  preserveGeneratorEvidence: vi.fn(async () => ({ reportId: 1, refused: [], counts: {} })),
  approveGeneratorEvidenceReport: vi.fn(async () => ({ approved: true })),
  getEvidenceTriggers: vi.fn(async () => []),
  getEvidenceWorkflows: vi.fn(async () => ({ items: [] })),
  getGeneratorEvidenceReport: vi.fn(async () => null),
  recopyGeneratorEvidenceFile: vi.fn(async () => ({ status: 'preserved' })),
  excludeGeneratorEvidenceFile: vi.fn(async () => ({ version: 'v' })),
  clearUnconfirmedOpens: vi.fn(async () => ({ cleared: true })),
  getCsamReportsPaged: vi.fn(async () => ({ items: [] })),
  getCsamReportStats: vi.fn(async () => ({})),
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

vi.mock('~/server/services/csam-unconfirmed-open', async (importOriginal) => ({
  ...(await importOriginal<typeof UnconfirmedOpen>()),
  clearUnconfirmedOpens,
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  getCsamReportsPaged,
  getCsamReportStats,
}));

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
    expect(await codeOf(member.recopyGeneratorEvidenceFile(file))).toBe('FORBIDDEN');
    expect(
      await codeOf(member.excludeGeneratorEvidenceFile({ ...file, reason: 'damaged copy' }))
    ).toBe('FORBIDDEN');
    expect(preserveGeneratorEvidence).not.toHaveBeenCalled();
    expect(approveGeneratorEvidenceReport).not.toHaveBeenCalled();
    expect(recopyGeneratorEvidenceFile).not.toHaveBeenCalled();
    expect(excludeGeneratorEvidenceFile).not.toHaveBeenCalled();
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

    expect(await codeOf(moderator.approveGeneratorEvidence(approve))).toBe('ok');
    expect(await codeOf(moderator.recopyGeneratorEvidenceFile(file))).toBe('ok');
    expect(
      await codeOf(moderator.excludeGeneratorEvidenceFile({ ...file, reason: 'damaged copy' }))
    ).toBe('ok');
    for (const service of [
      approveGeneratorEvidenceReport,
      recopyGeneratorEvidenceFile,
      excludeGeneratorEvidenceFile,
    ]) {
      expect(service).toHaveBeenCalledTimes(1);
      expect(service).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, moderatorId: 5 }));
    }
  });
});

describe('CSAM report reads and clearing an unconfirmed open', () => {
  const clear = () => ({ reportId: 3, note: 'checked with NCMEC' });

  it('refuse a member, and a moderator without CSAM reporting access', async () => {
    for (const refused of [
      caller({ id: 5, isModerator: false }, true),
      caller({ id: 5, isModerator: true }, false),
    ]) {
      expect(await codeOf(refused.getCsamReports({ page: 1, limit: 20 }))).toBe('FORBIDDEN');
      expect(await codeOf(refused.getCsamReportsStats())).toBe('FORBIDDEN');
      expect(await codeOf(refused.clearUnconfirmedOpen(clear()))).toBe('FORBIDDEN');
    }
    expect(getCsamReportsPaged).not.toHaveBeenCalled();
    expect(getCsamReportStats).not.toHaveBeenCalled();
    expect(clearUnconfirmedOpens).not.toHaveBeenCalled();
  });

  it('let a moderator with CSAM reporting access through, clearing as that moderator', async () => {
    const moderator = caller({ id: 5, isModerator: true }, true);
    expect(await codeOf(moderator.getCsamReports({ page: 1, limit: 20 }))).toBe('ok');
    expect(await codeOf(moderator.getCsamReportsStats())).toBe('ok');
    expect(
      await codeOf(moderator.clearUnconfirmedOpen({ ...clear(), moderatorId: 99 } as never))
    ).toBe('ok');
    expect(clearUnconfirmedOpens).toHaveBeenCalledWith(
      expect.objectContaining({ ...clear(), moderatorId: 5 })
    );
  });
});
