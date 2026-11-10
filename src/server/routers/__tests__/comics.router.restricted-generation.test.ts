import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as TosReacceptance from '~/server/services/tos-reacceptance.service';

const { shouldOfferTosReacceptance } = vi.hoisted(() => ({
  shouldOfferTosReacceptance: vi.fn(async (_userId: number) => false),
}));
vi.mock('~/server/services/tos-reacceptance.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TosReacceptance>()),
  shouldOfferTosReacceptance,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
  RESTRICTED_ACCOUNT_MESSAGE,
} from '~/server/common/content-restriction';

const GENERATION_PROCEDURES = [
  'generateComicImage',
  'iterateGenerate',
  'createPanel',
  'enhancePanel',
  'bulkCreatePanels',
  'smartCreateChapter',
  'enhancePromptText',
  'unlockPanelGeneration',
  'planChapterPanels',
] as const;

function caller(user: Record<string, unknown>) {
  return comicsRouter.createCaller({
    user: { id: 7, isModerator: false, onboarding: OnboardingSteps.Buzz, ...user },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never) as unknown as Record<string, (input: unknown) => Promise<unknown>>;
}

function givenAccount(row: { muted: boolean; bannedAt: Date | null } | null) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);
}

beforeEach(() => {
  dbMock.dbWrite.user.findUnique.mockReset();
  shouldOfferTosReacceptance.mockReset().mockResolvedValue(false);
});

// `{}` fails every procedure's input schema, so an account the check admits is refused with
// BAD_REQUEST instead, which is what tells the two outcomes apart.
describe('comic generation refuses a restricted account', () => {
  it.each(GENERATION_PROCEDURES)(
    '%s refuses an account the primary says is muted, whatever the session says',
    async (name) => {
      givenAccount({ muted: true, bannedAt: null });
      await expect(caller({ muted: false })[name]({})).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: RESTRICTED_ACCOUNT_MESSAGE,
      });
      expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 7 } })
      );
    }
  );

  // The way out `guardedProcedure` offers: re-accepting the Terms lifts this kind of mute.
  it.each(GENERATION_PROCEDURES)(
    '%s offers the Terms to a muted account they would release',
    async (name) => {
      shouldOfferTosReacceptance.mockResolvedValue(true);
      givenAccount({ muted: true, bannedAt: null });
      const error = await caller({ muted: false })
        [name]({})
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'FORBIDDEN', message: RESTRICTED_ACCOUNT_MESSAGE });
      expect((error as { cause?: { tosReacceptRequired?: boolean } }).cause).toMatchObject({
        tosReacceptRequired: true,
      });
    }
  );

  it('refuses a banned account', async () => {
    givenAccount({ muted: false, bannedAt: new Date('2026-01-01') });
    await expect(caller({})['createPanel']({})).rejects.toMatchObject({
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
  });

  it.each(GENERATION_PROCEDURES)(
    '%s admits an unrestricted account that has neither verified its email nor finished onboarding',
    async (name) => {
      givenAccount({ muted: false, bannedAt: null });
      const error = await caller({
        muted: false,
        onboarding: 0,
        emailVerified: null,
        meta: { emailVerificationRequired: true },
      })
        [name]({})
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });
      expect((error as Error).message).not.toBe(EMAIL_VERIFICATION_REQUIRED_MESSAGE);
    }
  );
});
