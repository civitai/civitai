import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppFeedbackService from '~/server/services/blocks/app-feedback.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Token-scope gate on `appFeedback`. The ledger and the "admits a token carrying AppBlocksSubmit"
 * arm fail without the router's `.meta`; the other arms pass either way.
 */

const svc = vi.hoisted(() => ({
  listAppFeedbackForListing: vi.fn(),
  hasAnyAppFeedbackForListing: vi.fn(),
  countNewAppFeedbackForMyListings: vi.fn(),
  setAppFeedbackOwnerStatus: vi.fn(),
  flagAppFeedbackAbusive: vi.fn(),
  getAppFeedbackEligibility: vi.fn(),
  createAppFeedback: vi.fn(),
  modListAppFeedback: vi.fn(),
  modCountFlaggedAppFeedback: vi.fn(),
  modSetAppFeedbackHidden: vi.fn(),
}));

vi.mock('~/server/services/blocks/app-feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppFeedbackService>()),
  ...svc,
}));

const { appFeedbackRouter } = await import('~/server/routers/app-feedback.router');

// Literals, so a renumbered enum fails the sanity test instead of moving every arm with it.
const FULL = 33554431;
const SUBMIT = 1 << 25; // 33554432
const WITH_SUBMIT = 1 | SUBMIT; // UserRead | AppBlocksSubmit
// Scoped tokens that lack the bit: a narrow one, and every ordinary scope but one.
const WITHOUT_SUBMIT = [
  ['UserRead|AppBlocksDevTunnel', 1 | (1 << 26)],
  ['Full minus UserWrite', FULL & ~2],
] as const;

const SCOPE_GATE_ERROR = {
  code: 'FORBIDDEN',
  message: 'Your API key does not have the required scope for this action',
};

const onboarded = { onboarding: OnboardingSteps.Buzz, muted: false };
// Not a moderator: the inbox procedures must answer an ordinary developer.
const owner = { id: 1001, isModerator: false, ...onboarded };
const moderator = { id: 6006, isModerator: true, ...onboarded };
type User = typeof owner;

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

// A personal API key: moderator procedures take no other bearer credential.
const tokenCtx = (user: User, tokenScope: number) =>
  ({
    ...(sessionCtx(user) as object),
    apiKeyId: 999,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 999 },
    tokenScope,
  } as never);

type Proc = { name: string; user: User; input: unknown; mock: ReturnType<typeof vi.fn> };
// `reaches`: the service arguments, with the caller bound from the session and never the input.
type AnnotatedProc = Proc & { reaches: unknown[] };

const ANNOTATED: AnnotatedProc[] = [
  {
    name: 'listForListing',
    user: owner,
    input: { appListingId: 'lst_1', userId: 1 },
    mock: svc.listAppFeedbackForListing,
    reaches: [{ userId: 1001, input: { appListingId: 'lst_1', limit: 50 } }],
  },
  {
    name: 'countNewForMyListings',
    user: owner,
    input: undefined,
    mock: svc.countNewAppFeedbackForMyListings,
    reaches: [1001],
  },
  {
    name: 'setOwnerStatus',
    user: owner,
    input: {
      id: 7,
      appListingId: 'lst_1',
      ownerStatus: 'acknowledged',
      expectedOwnerStatus: null,
      userId: 1,
    },
    mock: svc.setAppFeedbackOwnerStatus,
    reaches: [
      {
        userId: 1001,
        input: {
          id: 7,
          appListingId: 'lst_1',
          ownerStatus: 'acknowledged',
          expectedOwnerStatus: null,
        },
      },
    ],
  },
  {
    name: 'flagAbusive',
    user: owner,
    input: { id: 7, appListingId: 'lst_1', userId: 1 },
    mock: svc.flagAppFeedbackAbusive,
    reaches: [{ userId: 1001, input: { id: 7, appListingId: 'lst_1' } }],
  },
];

const UNANNOTATED: Proc[] = [
  {
    name: 'hasAnyForListing',
    user: owner,
    input: { appListingId: 'lst_1' },
    mock: svc.hasAnyAppFeedbackForListing,
  },
  {
    name: 'getEligibility',
    user: moderator,
    input: { target: { slug: 'a' } },
    mock: svc.getAppFeedbackEligibility,
  },
  {
    name: 'create',
    user: moderator,
    input: { target: { slug: 'a' }, message: 'hi', context: { surface: 'page' } },
    mock: svc.createAppFeedback,
  },
  { name: 'modList', user: moderator, input: {}, mock: svc.modListAppFeedback },
  {
    name: 'modCountFlagged',
    user: moderator,
    input: undefined,
    mock: svc.modCountFlaggedAppFeedback,
  },
  {
    name: 'modSetHidden',
    user: moderator,
    input: { id: 9, hidden: true },
    mock: svc.modSetAppFeedbackHidden,
  },
];

const call = (ctx: never, { name, input }: Proc) =>
  (
    appFeedbackRouter.createCaller(ctx) as never as Record<string, (i: unknown) => Promise<unknown>>
  )[name](input);

const expectNoServiceCalls = () => {
  for (const mock of Object.values(svc)) expect(mock).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(svc)) mock.mockResolvedValue({ reached: true });
});

describe('appFeedback token-scope gate', () => {
  it('the literal masks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(SUBMIT);
    expect(TokenScope.UserRead | TokenScope.AppBlocksSubmit).toBe(WITH_SUBMIT);
    expect(TokenScope.UserRead | TokenScope.AppBlocksDevTunnel).toBe(WITHOUT_SUBMIT[0][1]);
    for (const [, mask] of WITHOUT_SUBMIT) expect(mask & SUBMIT).toBe(0);
  });

  // Read off the built router, so an un-annotated procedure reads as `null` rather than being
  // indistinguishable from one annotated with Full. Lists every procedure: adding one, or adding
  // or dropping an annotation, fails here until the scope decision is written down.
  it('exactly the four procedures a token caller needs require AppBlocksSubmit', () => {
    const procedures = appFeedbackRouter._def.procedures as unknown as Record<
      string,
      { _def: { meta?: { requiredScope?: number; blockApiKeys?: boolean } } }
    >;
    const ledger = Object.fromEntries(
      Object.entries(procedures).map(([name, p]) => [name, p._def.meta ?? null])
    );
    expect(ledger).toEqual({
      getEligibility: null,
      create: null,
      listForListing: { requiredScope: 33554432 },
      hasAnyForListing: null,
      setOwnerStatus: { requiredScope: 33554432 },
      flagAbusive: { requiredScope: 33554432 },
      countNewForMyListings: { requiredScope: 33554432 },
      modList: null,
      modCountFlagged: null,
      modSetHidden: null,
    });
  });

  describe.each(ANNOTATED)('$name (annotated)', (proc) => {
    it('admits a token carrying AppBlocksSubmit', async () => {
      await expect(call(tokenCtx(proc.user, WITH_SUBMIT), proc)).resolves.toEqual({
        reached: true,
      });
      expect(proc.mock).toHaveBeenCalledTimes(1);
      expect(proc.mock).toHaveBeenCalledWith(...proc.reaches);
    });

    it.each(WITHOUT_SUBMIT)('refuses a scoped token without it (%s)', async (_label, mask) => {
      await expect(call(tokenCtx(proc.user, mask), proc)).rejects.toMatchObject(SCOPE_GATE_ERROR);
      expectNoServiceCalls();
    });
  });

  describe.each(UNANNOTATED)('$name (not annotated)', (proc) => {
    it('refuses a token carrying AppBlocksSubmit', async () => {
      await expect(call(tokenCtx(proc.user, WITH_SUBMIT), proc)).rejects.toMatchObject(
        SCOPE_GATE_ERROR
      );
      expectNoServiceCalls();
    });
  });

  describe.each([...ANNOTATED, ...UNANNOTATED])('$name', (proc) => {
    it('still answers a Full API key', async () => {
      await expect(call(tokenCtx(proc.user, FULL), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });

    it('still answers a cookie session', async () => {
      await expect(call(sessionCtx(proc.user), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });
  });
});
