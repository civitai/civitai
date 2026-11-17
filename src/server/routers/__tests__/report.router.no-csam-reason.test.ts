import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReportController from '~/server/controllers/report.controller';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

vi.mock('~/server/controllers/report.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportController>()),
  createReportHandler: vi.fn(async () => null),
}));

const { reportRouter } = await import('~/server/routers/report.router');
const { createCallerFactory } = await import('~/server/trpc');
const { createReportHandler } = await import('~/server/controllers/report.controller');

const call = createCallerFactory(reportRouter);

const MODERATOR = {
  id: 2,
  isModerator: true,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  deletedAt: null,
  muted: false,
};

const ctx = {
  user: MODERATOR,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: {},
  track: { action: vi.fn(async () => undefined) },
  ip: '127.0.0.1',
  cache: {},
  req: undefined,
  res: undefined,
} as never;

beforeEach(() => vi.mocked(createReportHandler).mockClear());

// CSAM is filed only through the CSAM report flow, which keeps the evidence and the blocklist
// entry. report.create must not take the reason, even from a moderator.
describe('report.create and the CSAM reason', () => {
  it("refuses a moderator's CSAM report before anything runs", async () => {
    await expect(
      call(ctx).create({ type: ReportEntity.Image, id: 500, reason: ReportReason.CSAM } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createReportHandler).not.toHaveBeenCalled();
  });

  it("files a moderator's TOS report (control)", async () => {
    await call(ctx).create({
      type: ReportEntity.Image,
      id: 500,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Spam' },
    } as never);
    expect(createReportHandler).toHaveBeenCalledTimes(1);
  });
});
