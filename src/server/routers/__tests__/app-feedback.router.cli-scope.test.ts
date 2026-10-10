import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppFeedbackService from '~/server/services/blocks/app-feedback.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Token-scope gate on `appFeedback`: which procedures a scoped API token may reach.
 *
 * Only the "token carrying AppBlocksSubmit is admitted" arm fails without the router's
 * `.meta({ requiredScope })`. The refusal, Full-key and session arms pass either way; they pin
 * that the annotation neither opened the gate to another scope nor reached the procedures left
 * un-annotated.
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

// A moderator who finished onboarding, so on every procedure tier the scope gate is the only
// thing left to refuse the call.
const user = { id: 1001, isModerator: true, onboarding: OnboardingSteps.Buzz, muted: false };

const sessionCtx = () =>
  ({
    user,
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    features: {},
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);

const tokenCtx = (tokenScope: number) =>
  ({ ...(sessionCtx() as object), apiKeyId: 999, tokenScope } as never);

type Proc = { name: string; input: unknown; mock: ReturnType<typeof vi.fn> };

const ANNOTATED: Proc[] = [
  { name: 'listForListing', input: { appListingId: 'lst_1' }, mock: svc.listAppFeedbackForListing },
  {
    name: 'hasAnyForListing',
    input: { appListingId: 'lst_1' },
    mock: svc.hasAnyAppFeedbackForListing,
  },
  { name: 'countNewForMyListings', input: undefined, mock: svc.countNewAppFeedbackForMyListings },
  {
    name: 'setOwnerStatus',
    input: {
      id: 7,
      appListingId: 'lst_1',
      ownerStatus: 'acknowledged',
      expectedOwnerStatus: null,
    },
    mock: svc.setAppFeedbackOwnerStatus,
  },
  {
    name: 'flagAbusive',
    input: { id: 7, appListingId: 'lst_1' },
    mock: svc.flagAppFeedbackAbusive,
  },
];

const UNANNOTATED: Proc[] = [
  { name: 'getEligibility', input: { target: { slug: 'a' } }, mock: svc.getAppFeedbackEligibility },
  {
    name: 'create',
    input: { target: { slug: 'a' }, message: 'hi', context: { surface: 'page' } },
    mock: svc.createAppFeedback,
  },
  { name: 'modList', input: {}, mock: svc.modListAppFeedback },
  { name: 'modCountFlagged', input: undefined, mock: svc.modCountFlaggedAppFeedback },
  { name: 'modSetHidden', input: { id: 9, hidden: true }, mock: svc.modSetAppFeedbackHidden },
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
  it('exactly the five owner-side procedures require AppBlocksSubmit', () => {
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
      hasAnyForListing: { requiredScope: 33554432 },
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
      await expect(call(tokenCtx(WITH_SUBMIT), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });

    it.each(WITHOUT_SUBMIT)('refuses a scoped token without it (%s)', async (_label, mask) => {
      await expect(call(tokenCtx(mask), proc)).rejects.toMatchObject(SCOPE_GATE_ERROR);
      expectNoServiceCalls();
    });
  });

  describe.each(UNANNOTATED)('$name (not annotated)', (proc) => {
    it('refuses a token carrying AppBlocksSubmit', async () => {
      await expect(call(tokenCtx(WITH_SUBMIT), proc)).rejects.toMatchObject(SCOPE_GATE_ERROR);
      expectNoServiceCalls();
    });
  });

  describe.each([...ANNOTATED, ...UNANNOTATED])('$name', (proc) => {
    it('still answers a Full API key', async () => {
      await expect(call(tokenCtx(FULL), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });

    it('still answers a cookie session', async () => {
      await expect(call(sessionCtx(), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });
  });
});
