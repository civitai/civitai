import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * `GET /api/v1/blocks/me` and `blocks.getMyViewer` are TWO FRONT DOORS TO ONE
 * CAPABILITY, and this file is the only thing that says so mechanically.
 *
 * ## The defect this exists to stop coming back
 *
 * `getMyViewer`'s docblock asserted it mirrored `me.ts` "EXACTLY". It did not. `me.ts`
 * carried a hardcoded `if (!user.isModerator) → 403` ("App Blocks is moderator-only
 * until GA") and NO App-Blocks flag gate; `getMyViewer` had the flag gate and no mod
 * literal. Both sit behind the same `app-blocks-enabled` Flipt audience, which is
 * base-false with a segment rollout whose members are MOSTLY moderators — so the literal
 * refused almost nobody the flag would have admitted, and the divergence was invisible.
 * It is not invisible for the hand-allowlisted NON-moderators already in that audience,
 * and it would have surfaced for every user admitted by the GA widen: the identical
 * capability succeeding over tRPC and 403-ing over REST.
 *
 * Resolved by dropping the literal — Flipt is the gate — and giving `me.ts` the flag
 * gate and rate limiter `getMyViewer` already had.
 *
 * ## What is pinned, and why it is pinned as a RELATIONSHIP
 *
 * Each case drives BOTH doors with ONE subject and ONE set of mocked dependencies, then
 * compares a normalised VERDICT — allow + body, or refuse + HTTP status + message — for
 * equality. Two separately-green handler suites is exactly the shape that let these two
 * disagree for months: every existing test was scoped to one surface, so none ever built
 * the combined state. A per-door assertion cannot see a divergence; only the comparison
 * can.
 *
 * Status codes are comparable across the protocols because `me.ts` derives its status
 * for the kill-switch refusal from tRPC's OWN `getHTTPStatusCodeFromError`, and this file
 * does the same to the thrown `TRPCError`. That is deliberate on both sides: a
 * hand-written code→status switch in the route is where the two would drift apart again.
 * (The route's other statuses — 405/401/403/404/429 — are literals on both sides, which
 * this file compares directly; only the kill-switch status is derived.)
 *
 * MESSAGES are compared too, EXCEPT on the kill-switch branch, where `me.ts` renders its
 * own generic literal instead of echoing the gate's. Case B says why at the assertion.
 *
 * ## Base-color matrix — MEASURED, not asserted from reading
 *
 * Method: a CLEAN checkout of the base commit (its own install, no shared node_modules),
 * these test files dropped in, this suite run there. Measured for all 10 cases at base
 * `0340f692bf`, then RE-measured at `d7038c5aa8` after the base moved under the branch:
 * **7 failed | 3 passed** both times, same cases. (Quoting a matrix from a base the branch
 * no longer sits on is a stale citation, so it is re-run rather than argued from.)
 * Case J was added later, after an audit mutant. The suite was RE-RUN at `d7038c5aa8` with
 * it included rather than its colour being reasoned about: **8 failed | 3 passed of 11**.
 * J is red at base for the same reason B and D are — the base has neither gate.
 *
 *   RED at base (7) — the regression coverage:
 *     A  non-mod IN the audience            REST 403 mod-literal      / tRPC 200
 *     B  moderator OUTSIDE the audience     REST 200 no-flag-gate     / tRPC 401
 *     C  non-mod IN the audience, banned    REST 403 'restricted…'    / tRPC 403 'banned'
 *     D  moderator, limiter refusing        REST 200 no limiter       / tRPC 429
 *     J  flag AND limiter both refusing     REST 200 neither gate      / tRPC 401
 *     F  non-mod muted viewer               REST 403 mod-literal      / tRPC 200 muted
 *     I  non-tRPC error out of the gate     base never calls the gate, so nothing throws
 *        and the call resolves instead of rejecting
 *     +  the flag-sees-the-token-subject case: `[[77]]` vs `[[77],[77]]` — one door never
 *        calls the gate at all
 *
 *   GREEN at base (3) — NOT regression coverage, and each labelled at its own assertion:
 *     E  subject row absent (null)          both 404 already
 *     G  subject row soft-deleted           both 404 already — the `deletedAt` branch
 *                                           precedes the old mod literal
 *     H  non-401 refusal, same status       both doors answer 403 at base BY COINCIDENCE
 *                                           (REST via the mod literal, the bridge via the
 *                                           injected FORBIDDEN), so it proves nothing
 *                                           about the old divergence. It is here purely as
 *                                           a MUTATION guard — the only case that kills a
 *                                           hardcoded refusal status.
 *
 * ⚠️ TWO LABELLING ERRORS ARE RECORDED HERE RATHER THAN QUIETLY CORRECTED, because both
 * were written from what a case was ADDED FOR instead of from running it. F was called a
 * green invariant guard and is red (its subject is a NON-moderator, so the old literal
 * refused it before `status: 'muted'` was computed). H was expected to be red and is
 * green. G, added in the same breath as F for the same reason, genuinely is green. Same
 * origin, three different answers — which is why every line above is measured.
 *
 * The seven reds fail in BOTH directions (REST too strict in A/C/F, too permissive in
 * B/D) across THREE distinct gates — the moderator literal (A, C, F), the missing flag
 * gate (B, I, and the flag-subject case) and the missing limiter (D) — so no single
 * mutation greens the set. ⚠️ Not "a different gate each": A, C and F all fail on the
 * same literal, and an earlier revision of this line said otherwise.
 *
 * ## Deliberately NOT pinned here
 *
 * The belts that run before either handler body: token signature/expiry, per-instance
 * revocation, backing-app approved-status, and the `user:read:self` scope check. They
 * live in `withBlockScope` on the REST side and `authorizeBlockBridgeToken` on the tRPC
 * side and are covered by `no-unguarded-block-rest-token.test.ts`,
 * `no-unguarded-block-bridge-token.test.ts` and the middleware suites. Both are mocked
 * to a pass here so a failure in this file is unambiguously about the gates that DID
 * diverge. Also not pinned: `me.ts`'s 405 (non-GET) and 401 (absent claims), which have
 * no tRPC counterpart to compare against.
 *
 * 🔴 THOSE EXCLUSIONS ARE NOT CLAIMS OF PARITY, AND TWO OF THEM ARE KNOWN TO DIVERGE.
 * Stated here so nobody reads "not pinned" as "equal". Neither is an allow/deny
 * inversion — both doors refuse — but the answers differ:
 *   - the scope refusal's TEXT (REST `missing required scope: user:read:self` from the
 *     wrapper; tRPC `block lacks user:read:self scope`), same 403 either way;
 *   - the ANON-subject refusal's STATUS: REST 403 / tRPC 401. On the REST side that
 *     refusal comes from `enforceContextBinding` inside the wrapper, not from the
 *     handler's own anon branch, which `requiredScope: 'user:read:self'` makes
 *     unreachable. ⚠️ UNMEASURED — read off the two code paths, not executed, and flagged
 *     as such because this header's own standard one section up is "MEASURED, not
 *     asserted from reading". Whether the case is even constructible depends on whether a
 *     token can carry `sub:'anon'` AND `user:read:self` at mint; nothing here tests it;
 *   - and `withBlockScope` runs `enforceContextBinding`, which the bridge has no
 *     equivalent of, so the REST door is STRICTER on a token carrying extra scopes.
 *
 * 🔴 A MALFORMED `sub` IS NOT ON THAT LIST, and an earlier revision of this header put it
 * there — claiming the bridge answers 500 where REST answers 403. That was wrong.
 * `verifyBlockToken` rejects any `sub` outside `anon` / `user:<1-12 digits>` before
 * returning claims, and BOTH doors go through it, so both are 401 `invalid block token`
 * and each handler's malformed-`sub` branch is unreachable defence-in-depth. Recorded
 * because the error is the one this whole file exists to prevent, pointing the other way:
 * a confident claim about the two doors that nobody had executed.
 * Pinning those means driving the real wrapper rather than a passthrough, which is a
 * different test from this one.
 */

const {
  mockIsAppBlocksEnabled,
  mockGetSessionUser,
  mockCheckRateLimit,
  mockAuthorizeBridgeToken,
  mockGetUserById,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockAuthorizeBridgeToken: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
}));

class ForbiddenError extends Error {
  readonly status = 403 as const;
}

// The claims BOTH doors resolve to. One object, so the two cannot be handed different
// subjects, scopes or instance ids by accident — that sharing is the point of the file.
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

// SHARED by both doors. withBlockScope is a passthrough that stamps req.blockClaims
// (mirroring what the real wrapper does once its own belts pass); parseSubjectUserId is
// a faithful re-implementation of the real one so the anon/malformed branches behave.
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('malformed sub claim');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));

// The tRPC door's pre-handler belts (validity → revocation → approved) resolve to the
// SAME claims object the REST door is stamped with.
vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBridgeToken(...a),
}));

// The two dependencies the SHARED gate reads. Mocking them by module specifier is what
// makes this file agnostic to where `assertAppBlocksEnabledForTokenUser` physically
// lives — it exercises the real gate on both doors, not a stub of it.
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));

// Heavy services stubbed so importing the router doesn't drag in the generated Prisma
// client / selectors. Mirrors `blocks.router.flag-gate.test.ts`.
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import restHandler from '~/pages/api/v1/blocks/me';
import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Referenced so the shared mock modules are loaded for the router's import graph.
void redisMock;
void loggingMock;
const mockFindUnique = dbMock.dbWrite.user.findUnique;

const SUBJECT_ID = 77;
const INSTANCE_ID = 'bki_parity';

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${SUBJECT_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_parity',
    blockInstanceId: INSTANCE_ID,
    ctx: {},
    scopes: ['user:read:self'],
    buzzBudget: 250,
    ...over,
  } as BlockTokenClaims;
}

/** The db row both doors read via `dbWrite.user.findUnique`. */
function userRow(over: Record<string, unknown> = {}) {
  return {
    id: SUBJECT_ID,
    username: 'viewer',
    bannedAt: null,
    muted: false,
    deletedAt: null,
    // `me.ts` used to select this to run its hardcoded gate. Left on the fixture ON
    // PURPOSE: if the literal is ever reintroduced it will find a value to refuse on,
    // so case A fails on the divergence rather than on a missing column.
    isModerator: false,
    ...over,
  };
}

/** The SessionUser the shared gate hydrates before evaluating the flag. */
function sessionUser(over: Record<string, unknown> = {}) {
  return { id: SUBJECT_ID, username: 'viewer', isModerator: false, tier: 'free', ...over };
}

type Verdict =
  | { outcome: 'allow'; body: unknown }
  | { outcome: 'refuse'; status: number; message: string };

async function callRest(): Promise<Verdict> {
  let statusCode = 200;
  let payload: any;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {
      return undefined;
    },
    end() {
      return res;
    },
  };
  const req: any = {
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  await (restHandler as any)(req, res);
  return statusCode === 200
    ? { outcome: 'allow', body: payload }
    : { outcome: 'refuse', status: statusCode, message: String(payload?.error) };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    // NO session user. A `dev:live` block call carries no civitai cookie, and the whole
    // point of the shared gate is that the flag is evaluated against the TOKEN subject
    // rather than `ctx.user` — leaving this undefined keeps that honest.
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

async function callTrpc(): Promise<Verdict> {
  const caller = blocksRouter.createCaller(fakeCtx() as never);
  try {
    const body = await caller.getMyViewer({ blockToken: 'tok' });
    return { outcome: 'allow', body };
  } catch (err) {
    if (err instanceof TRPCError) {
      return {
        outcome: 'refuse',
        status: getHTTPStatusCodeFromError(err),
        message: err.message,
      };
    }
    throw err;
  }
}

/**
 * Drive both doors against the SAME state. The db mock is re-primed between the two
 * calls (each door reads it exactly once) so neither can consume the other's
 * `mockResolvedValueOnce`.
 */
async function bothDoors(row: unknown | null): Promise<{ rest: Verdict; trpc: Verdict }> {
  mockFindUnique.mockResolvedValue(row);
  const rest = await callRest();
  mockFindUnique.mockResolvedValue(row);
  const trpc = await callTrpc();
  return { rest, trpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockAuthorizeBridgeToken.mockImplementation(async () => claimsBox.claims);
  mockGetSessionUser.mockResolvedValue(sessionUser());
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockFindUnique.mockResolvedValue(userRow());
});

describe('/api/v1/blocks/me and blocks.getMyViewer return the SAME authorization verdict', () => {
  it('A: a NON-MODERATOR inside the app-blocks-enabled audience is ALLOWED on both doors', async () => {
    // The population the GA widen creates, and the one the hardcoded literal broke: the
    // flag admits this subject, and `isModerator` is false on BOTH the db row and the
    // hydrated SessionUser.
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: false }));
    mockIsAppBlocksEnabled.mockResolvedValue(true);

    const { rest, trpc } = await bothDoors(userRow({ isModerator: false }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({
      outcome: 'allow',
      body: { id: SUBJECT_ID, username: 'viewer', status: 'active', buzzBudget: 250 },
    });
  });

  it('B: a MODERATOR outside the audience is REFUSED on both doors — Flipt is the gate, not the role', async () => {
    // The inverse direction, and the one that proves the fix is not "delete a check":
    // the flag is what decides, so a moderator the flag does not admit is refused HERE
    // too. Without the shared gate on `me.ts` this case is REST-allow / tRPC-refuse.
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: true }));
    mockIsAppBlocksEnabled.mockResolvedValue(false);

    const { rest, trpc } = await bothDoors(userRow({ isModerator: true }));

    // 🔴 STATUS, NOT TEXT, ON THIS ONE BRANCH — and the asymmetry is deliberate, not a
    // gap. `me.ts` renders both kill-switch refusals with its own generic literal rather
    // than echoing the gate's message: `rest-error-envelope-ledger.test.ts` blocks a REST
    // route from serialising a caught error's `.message`, and the gate's other message is
    // a compiled-branch watchlist anchor that must stay unique app-wide, so re-spelling it
    // here to win text parity would break that guard. Every OTHER case in this file still
    // compares the whole verdict including the message.
    expect(rest.outcome).toBe('refuse');
    expect(trpc.outcome).toBe('refuse');
    expect((rest as { status: number }).status).toBe((trpc as { status: number }).status);
    expect((rest as { status: number }).status).toBe(401);
    expect((rest as { message: string }).message).toBe('Apps are not enabled');
    // The operator-facing text stays off the wire on the REST door.
    expect((trpc as { message: string }).message).toBe('Apps are not enabled');
    // Refused BEFORE the primary read, on both doors.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('C: a banned NON-MODERATOR inside the audience is refused for the SAME reason on both doors', async () => {
    // Asserts the MESSAGE, not just the status. Both doors answer 403 here, so a
    // status-only assertion is satisfied by the old mod-literal refusing for an
    // unrelated reason — which is exactly how this case would have gone green wrongly.
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: false }));

    const { rest, trpc } = await bothDoors(userRow({ isModerator: false, bannedAt: new Date() }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({ outcome: 'refuse', status: 403, message: 'banned' });
  });

  it('D: an over-limit block instance is refused on both doors, on the same bucket', async () => {
    // A MODERATOR subject deliberately: it isolates the limiter, since the mod literal
    // could never have refused this caller. `me.ts` had no limiter at all.
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: true }));
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });

    const { rest, trpc } = await bothDoors(userRow({ isModerator: true }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({
      outcome: 'refuse',
      status: 429,
      message: 'Rate limit exceeded, please retry shortly.',
    });
    // Both keyed on the stable per-instance id, never on `jti`, and both refuse BEFORE
    // the primary read the limiter exists to bound.
    //
    // 🔴 `mock.calls`, NOT `toHaveBeenCalledWith` — and this is the whole reason a
    // cross-door file needs a different matcher from a per-door one. `toHaveBeenCalledWith`
    // passes when ANY call matched, and there are exactly two calls here, one per door: it
    // is therefore satisfied by EITHER door alone, which is the one thing this file must
    // never be. Measured: with `toHaveBeenCalledWith`, keying ONE door's limiter on
    // `claims.jti` instead of `claims.blockInstanceId` left this file fully green. Asserting
    // the call LIST pins both.
    expect(mockCheckRateLimit.mock.calls).toEqual([[INSTANCE_ID], [INSTANCE_ID]]);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('J: flag REFUSING and limiter REFUSING at once — both doors answer the kill-switch', async () => {
    // 🔴 THE ONLY CASE THAT OBSERVES THE ORDER OF THE TWO NEW GATES RELATIVE TO EACH OTHER,
    // and it exists because an audit mutant proved the rest of this file cannot. Moving the
    // limiter block ABOVE the kill-switch try/catch in `me.ts` left this file 10/10 green
    // and 16 sibling suites 417/417 green: every other case sets at most ONE of the two
    // refusals, and with only one armed the order is unobservable — whichever gate is armed
    // answers, wherever it sits.
    //
    // Arm BOTH and the order becomes the whole verdict: the kill-switch runs first, so both
    // doors must answer 401 `Apps are not enabled`. Under the swap the REST door answers
    // 429 `Rate limit exceeded…` while the bridge still answers 401 — the two front doors
    // disagreeing about which refusal a subject gets, which is this file's entire subject.
    //
    // ⚠️ Position relative to the PRIMARY READ was already pinned, by B and D's
    // `expect(mockFindUnique).not.toHaveBeenCalled()` (that killed a gate-after-db mutant).
    // Position relative to EACH OTHER is what was not, and it is what three docblocks claim
    // ("same position", "same placement"). A docblock claiming coverage the test lacks is
    // the defect this whole PR is about; it would have been one more instance of it.
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: true }));
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });

    const { rest, trpc } = await bothDoors(userRow({ isModerator: true }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({ outcome: 'refuse', status: 401, message: 'Apps are not enabled' });
    // The positive half of the same claim: because the kill-switch refuses first, NEITHER
    // door ever reaches the limiter. A swapped door would have consulted it.
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('E (invariant guard, green before the change too): a vanished subject row is 404 on both doors', async () => {
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: true }));

    const { rest, trpc } = await bothDoors(null);

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({ outcome: 'refuse', status: 404, message: 'User not found' });
  });

  it('both doors evaluate the App-Blocks flag against the TOKEN subject, never a session user', async () => {
    mockGetSessionUser.mockResolvedValue(sessionUser({ isModerator: false }));

    await bothDoors(userRow());

    // 🔴 THE CALL LIST, NOT `toHaveBeenCalledWith`. Same trap as case D and it bit harder
    // here: with `toHaveBeenCalledWith(SUBJECT_ID)`, changing the REST door to evaluate the
    // kill-switch against a HARDCODED WRONG SUBJECT left the entire repo suite green — the
    // tRPC door's correct call supplied the match. That is precisely the identity defect
    // this gate's docblock says the design exists to prevent, and the test named for it
    // could not see it. Both doors must hydrate the self-bound token subject.
    expect(mockGetSessionUser.mock.calls).toEqual([[SUBJECT_ID], [SUBJECT_ID]]);
    // ...and the flag sees that hydrated user, not `ctx.user` (which is undefined here).
    expect(mockIsAppBlocksEnabled.mock.calls).toEqual([
      [{ user: sessionUser({ isModerator: false }) }],
      [{ user: sessionUser({ isModerator: false }) }],
    ]);
  });

  it('H: a NON-401 kill-switch refusal answers the SAME status on both doors', async () => {
    // ⚠️ GREEN AT BASE — this is NOT regression coverage, and the base matrix in the header
    // says so. Both doors answer 403 at base by coincidence (REST via the mod literal, the
    // bridge via the injected FORBIDDEN), so this case proves nothing about the divergence
    // the file exists for. It is kept purely as a MUTATION guard:
    //
    // 🔴 THE ONLY CASE THAT EXERCISES THE STATUS *DERIVATION*, and it exists because the
    // claim was unasserted: with every refusal the gate can currently produce being
    // UNAUTHORIZED, replacing `getHTTPStatusCodeFromError(trpcError)` with a literal `401`
    // in me.ts left the whole suite green. Derived and hardcoded were observationally
    // identical at the single point the other cases sample. The day either gate refusal
    // becomes FORBIDDEN, a hardcoded route would answer 401 against the bridge's 403 —
    // exactly the drift this file exists to stop.
    //
    // ⚠️ HONEST LIMIT: this drives the mechanism by making a DEPENDENCY throw, not by
    // reaching a state the gate produces today. It pins the derivation, not a live
    // divergence.
    mockIsAppBlocksEnabled.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'nope' }));

    const { rest, trpc } = await bothDoors(userRow());

    expect(rest.outcome).toBe('refuse');
    expect(trpc.outcome).toBe('refuse');
    expect((rest as { status: number }).status).toBe((trpc as { status: number }).status);
    expect((rest as { status: number }).status).toBe(403);
  });

  it('I: a NON-tRPC error out of the gate is RETHROWN, never rendered as a refusal', async () => {
    // Pins the catch's disposition, which the me.ts docblock asserts and nothing measured:
    // widening the duck-type to `if (true)` left all cases green while turning a plain
    // `Error` into `500 {"error":"Apps are not enabled"}` on a third-party iframe — an
    // infrastructure failure wearing a policy refusal's clothes, which is the same
    // one-observable-two-mechanisms trap the route's own comment argues against.
    mockGetSessionUser.mockRejectedValue(new Error('session service down'));

    await expect(callRest()).rejects.toThrow('session service down');
  });

  it('F: a MUTED viewer passes through as `status: "muted"` on both doors', async () => {
    // Pins an item the `getMyViewer` docblock lists as shared. Added after a mutation
    // sweep showed that collapsing one door's `status` to always-'active' left this file
    // green — the SHARED list was wider than the file that is cited as proving it.
    // It is ALSO red at base (the subject is a non-moderator, so the old literal refused
    // it before `status` was computed); see the base-color matrix in the header.
    const { rest, trpc } = await bothDoors(userRow({ muted: true }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({
      outcome: 'allow',
      body: { id: SUBJECT_ID, username: 'viewer', status: 'muted', buzzBudget: 250 },
    });
  });

  it('G (invariant guard, green before the change too): a SOFT-DELETED subject row is 404 on both doors', async () => {
    // ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — green at base, like E and H. Labelled
    // here in the title AND the body because the header claims all three greens are
    // "labelled at their own assertion" and this one was the exception: its comment
    // explained only how it differs from E, so a reader landing here from a failure got no
    // in-place signal that it never diverged.
    //
    // Distinct from case E, which serves a NULL row. Same sweep: dropping one door's
    // `deletedAt` check left case E green, because a null row never exercises it.
    const { rest, trpc } = await bothDoors(userRow({ deletedAt: new Date() }));

    expect(rest).toEqual(trpc);
    expect(rest).toEqual({ outcome: 'refuse', status: 404, message: 'User not found' });
  });
});
