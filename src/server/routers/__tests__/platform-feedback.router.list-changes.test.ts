import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as PlatformFeedbackService from '~/server/services/platform-feedback.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Who reaches `platformFeedback.listChanges`, the moderator change feed: a moderator on a session or
 * on a full-scope personal API key, and nobody else. The other two procedures answer agent tokens
 * carrying `AppBlocksSubmit`, so this pins that the opt-in bit those use does not open the feed.
 */

const svc = vi.hoisted(() => ({ listPlatformFeedbackChanges: vi.fn() }));

vi.mock('~/server/services/platform-feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformFeedbackService>()),
  ...svc,
}));

const { platformFeedbackRouter } = await import('~/server/routers/platform-feedback.router');

// Literals, so a renumbered enum fails the sanity test instead of moving every arm with it.
const FULL = 33554431;
const SUBMIT = 1 << 25;
const SCOPED = [
  ['UserRead|AppBlocksSubmit (the agent token the other procedures take)', 1 | SUBMIT],
  ['Full|AppBlocksSubmit', FULL | SUBMIT],
  ['Full minus UserWrite', FULL & ~2],
  ['Read Only preset', TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaRead],
] as const;

const onboarded = { onboarding: OnboardingSteps.Buzz, muted: false };
const moderator = { id: 6006, isModerator: true, ...onboarded };
const developer = { id: 1001, isModerator: false, ...onboarded };
type User = typeof moderator;

const sessionCtx = (user: User) =>
  ({
    user,
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    features: {},
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);

const personalKeyCtx = (user: User, tokenScope: number) =>
  ({
    ...(sessionCtx(user) as object),
    apiKeyId: 999,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 999 },
    tokenScope,
  } as never);

const oauthCtx = (user: User, tokenScope: number) =>
  ({
    ...(sessionCtx(user) as object),
    apiKeyId: 999,
    apiKeyType: 'Access',
    subject: { type: 'oauth', id: 'client_1' },
    tokenScope,
  } as never);

// A fresh object per call: the procedure chain's browsing-level middleware writes into its input.
const INPUT = { cursor: '1767225600000:12', limit: 10 } as const;
const listChanges = (ctx: never) =>
  platformFeedbackRouter.createCaller(ctx).listChanges({ ...INPUT });

const NOT_A_MODERATOR = {
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action',
};
const NOT_A_FULL_KEY = {
  code: 'FORBIDDEN',
  message: 'This action requires a signed-in session or a full-access personal API key.',
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.listPlatformFeedbackChanges.mockResolvedValue({ reached: true });
});

describe('platformFeedback.listChanges access', () => {
  it('the literal masks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(SUBMIT);
  });

  it('answers a moderator on a session, with the parsed input', async () => {
    await expect(listChanges(sessionCtx(moderator))).resolves.toEqual({ reached: true });
    expect(svc.listPlatformFeedbackChanges).toHaveBeenCalledWith({
      cursor: '1767225600000:12',
      limit: 10,
    });
  });

  it('answers a moderator on a full-scope personal API key', async () => {
    await expect(listChanges(personalKeyCtx(moderator, FULL))).resolves.toEqual({ reached: true });
  });

  it('refuses a non-moderator, on a session and on a full-scope key', async () => {
    await expect(listChanges(sessionCtx(developer))).rejects.toMatchObject(NOT_A_MODERATOR);
    await expect(listChanges(personalKeyCtx(developer, FULL))).rejects.toMatchObject(
      NOT_A_MODERATOR
    );
    expect(svc.listPlatformFeedbackChanges).not.toHaveBeenCalled();
  });

  it.each(SCOPED)('refuses a moderator on a scoped personal key (%s)', async (_label, scope) => {
    await expect(listChanges(personalKeyCtx(moderator, scope))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(svc.listPlatformFeedbackChanges).not.toHaveBeenCalled();
  });

  it('refuses a moderator on an OAuth token, even a full-scope one', async () => {
    await expect(listChanges(oauthCtx(moderator, FULL))).rejects.toMatchObject(NOT_A_FULL_KEY);
    await expect(listChanges(oauthCtx(moderator, 1 | SUBMIT))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(svc.listPlatformFeedbackChanges).not.toHaveBeenCalled();
  });

  it('refuses a cursor that is not one the feed hands out, before the service', async () => {
    await expect(
      platformFeedbackRouter
        .createCaller(sessionCtx(moderator))
        .listChanges({ cursor: '2026-01-01T00:00:00Z' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      platformFeedbackRouter.createCaller(sessionCtx(moderator)).listChanges({ limit: 101 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(svc.listPlatformFeedbackChanges).not.toHaveBeenCalled();
  });
});
