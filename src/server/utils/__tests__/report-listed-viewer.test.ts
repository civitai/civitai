import { describe, expect, it } from 'vitest';
import { reportListedViewerOf } from '~/server/utils/report-listed-viewer';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

type Ctx = Parameters<typeof reportListedViewerOf>[0];

const moderator = { id: 1, isModerator: true } as Ctx['user'];
const user = { id: 2 } as Ctx['user'];
const grant = { csamReports: true } as Ctx['features'];
const scopedKey = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey' as const, id: 9 },
  tokenScope: TokenScope.ArticlesRead,
};

// Who sees report-listed images: the rule bounty images follow (#10483).
describe('reportListedViewerOf', () => {
  it('gives a grant-holding moderator on a session both views', () => {
    expect(reportListedViewerOf({ user: moderator, features: grant } as Ctx)).toEqual({
      seesReportListed: true,
      ownerSeesReportListed: true,
    });
  });

  it("gives a user on a session only the owner's view", () => {
    expect(reportListedViewerOf({ user, features: grant } as Ctx)).toEqual({
      seesReportListed: false,
      ownerSeesReportListed: true,
    });
  });

  it('gives a moderator without the grant no report-listed view', () => {
    expect(
      reportListedViewerOf({ user: moderator, features: {} as Ctx['features'] } as Ctx)
    ).toMatchObject({ seesReportListed: false });
  });

  it('gives a scoped key neither, the grant-holding moderator included', () => {
    expect(reportListedViewerOf({ user: moderator, features: grant, ...scopedKey } as Ctx)).toEqual(
      {
        seesReportListed: false,
        ownerSeesReportListed: false,
      }
    );
  });
});
