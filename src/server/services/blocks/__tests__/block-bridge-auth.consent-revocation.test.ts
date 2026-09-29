import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';
// Type-only namespace import, named up here: an inline `typeof import('…')` is rejected by
// @typescript-eslint/consistent-type-imports. Erased at compile time, so it does NOT load the
// module the factory below replaces.
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';

/**
 * PER-SCOPE CONSENT REVOCATION ON THE **tRPC BRIDGE** — the half the first cut left open.
 *
 * ## Why this file exists
 *
 * The marker was first wired into `withBlockScope` only, and asked one question: "is the
 * ROUTE's declared `requiredScope` revoked?". Review enumerated every `requiredScope:` under
 * `src/pages/api` and found that of the six consent-gated scopes, only four are ever declared
 * by a route. The two that are not are the two most sensitive:
 *
 *   - `posts:write:self` — authorized HERE, by `authorizeBlockPostRequest`'s
 *     `claims.scopes.includes('posts:write:self')`. The REST middleware is never on that path.
 *     The repo calls this "the first block scope that writes PUBLIC, feed-visible,
 *     reward-earning content under the VIEWER'S name".
 *   - `collections:read:private` — an in-handler sub-check under a route declaring the
 *     consent-EXEMPT `collections:read:self`.
 *
 * `buzz:read:self` and `user:read:self` are additionally read off `claims.scopes` by several
 * bridge procs, so those leaked the viewer's balance and account attributes for up to a token
 * lifetime after a revoke.
 *
 * ## What is pinned
 *
 * That `authorizeBlockBridgeToken` returns claims with the revoked scopes REMOVED — because
 * every bridge proc authorizes off `claims.scopes.includes(...)`, so one strip at this seam is
 * what makes all ~20 of them honour the revoke with no per-proc list to keep current. The
 * procs then refuse with their own existing "block lacks <scope> scope".
 *
 * RED at `a8b75427f5` (the pre-review commit): the bridge consulted no marker at all, so every
 * arm below returned the full scope set.
 */

const { mockVerifyBlockToken, mockIsRevoked, lookupMock, mockApprovalVerdict } = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockIsRevoked: vi.fn(async () => false),
  lookupMock: vi.fn<
    (opts: {
      userId: number;
      appBlockId: string;
    }) => Promise<
      { kind: 'none' } | { kind: 'revoked'; scopes: Set<string> } | { kind: 'unavailable' }
    >
  >(async () => ({ kind: 'none' })),
  mockApprovalVerdict: vi.fn(async () => 'ok'),
}));

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyBlockToken: mockVerifyBlockToken,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: mockIsRevoked },
}));
vi.mock('~/server/services/blocks/block-approval.service', () => ({
  resolveAppBlockApprovalVerdict: mockApprovalVerdict,
}));
/**
 * 🔴 ONLY THE REDIS-TOUCHING CLASS IS REPLACED; THE THREE PURE HELPERS STAY REAL. The service
 * under test imports `shouldConsultMarker`, `revokedScopesForToken` and `applyRevocations` from
 * this same specifier, and they hold the decisions worth exercising: which tokens are consulted
 * at all, what "unavailable" means, and what a strip leaves behind.
 */
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ConsentRevocation: { lookup: lookupMock },
}));

import client from 'prom-client';
import { authorizeBlockBridgeToken } from '../block-bridge-auth.service';

/**
 * Label sets on the real default registry.
 *
 * 🔴 NOT A MOCKED EMITTER. `recordConsentStrip` and the leaf `inc` live in the SAME module, so
 * `vi.mock` on the leaf cannot intercept the intra-module call — and mocking the fan-out instead
 * would stub out the intersection rule (emit per scope removed from THIS token, not per marker
 * entry) that these arms exist to pin. The registry sees the whole chain, clamp included.
 *
 * 🔴 THE `value` IS PART OF THE RETURN, AND OMITTING IT UNPINNED THE COUNTER'S ONLY CLAIM.
 * prom-client aggregates by LABEL SET, so a mapping that keeps `labels` alone reports one entry
 * whether the emitter incremented once or a hundred times — and "ONE increment per scope removed
 * from THAT request's token, NOT one per refusal" is exactly what the help text asserts. Measured
 * by round-4 review: two mutants that doubled the `inc` (in `recordConsentStrip` and in
 * `recordBlockConsentMarkerUnavailable`) both SURVIVED the full 237-test set. The version this
 * file replaced pinned it incidentally via `recordMock.mock.calls`; carrying `value` restores it
 * deliberately.
 */
async function labelsFor(name: string): Promise<Array<Record<string, string | number>>> {
  const metrics = await client.register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name) as
    | { values?: Array<{ labels: Record<string, string>; value: number }> }
    | undefined;
  return (m?.values ?? []).map((v) => ({ ...v.labels, value: v.value }));
}
const consentLabels = () => labelsFor('civitai_app_block_consent_revocation_refusals_total');
const unavailableLabels = () => labelsFor('civitai_app_block_consent_marker_unavailable_total');

const USER_ID = 4242;
const APP_BLOCK_ID = 'apb_bridge';
const POSTS = 'posts:write:self';
const BUZZ = 'buzz:read:self';
/** Consent-EXEMPT — signed without a grant, so no marker can ever name it. */
const EXEMPT = 'models:read:self';

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${USER_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_bridge',
    ctx: {},
    scopes: [POSTS, BUZZ, EXEMPT],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsRevoked.mockImplementation(async () => false);
  mockApprovalVerdict.mockImplementation(async () => 'ok');
  lookupMock.mockImplementation(async () => ({ kind: 'none' }));
  mockVerifyBlockToken.mockResolvedValue(claims());
  client.register.resetMetrics();
});

describe('authorizeBlockBridgeToken strips revoked scopes', () => {
  /**
   * 🔴 THE CENTRAL CLAIM. `posts:write:self` is authorized on this surface and nowhere else, so
   * this is the arm that makes revoking it mean anything.
   *
   * MUTATION THAT MUST KILL IT: delete the `ConsentRevocation` block from
   * `authorizeBlockBridgeToken`.
   */
  it('removes a revoked scope from the claims it returns', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    const out = await authorizeBlockBridgeToken('tok');
    expect(
      out.scopes,
      'the bridge returned the revoked scope. Every proc authorizes off ' +
        '`claims.scopes.includes(...)`, so `posts:write:self` — the one scope that publishes ' +
        'public content under the viewer’s name — would still be granted for the rest of the ' +
        'token’s life.'
    ).toEqual([BUZZ, EXEMPT]);
  });

  /**
   * 🔴 THE CONTROL. Same token, same fixture, nothing revoked ⇒ the full set comes back. Without
   * it, a service that always returned an empty scope list would pass the arm above.
   */
  it('CONTROL: returns the full set when nothing is revoked', async () => {
    lookupMock.mockResolvedValue({ kind: 'none' });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  it('strips several scopes at once and keeps the rest', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS, BUZZ]) });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([EXEMPT]);
  });

  /**
   * 🔴 FAILS CLOSED AS A **RETRYABLE** REFUSAL, NOT A SILENT STRIP — AND THE STRIP WAS A REAL
   * HARM, NOT A STYLE CHOICE.
   *
   * With a strip, `{kind:'unavailable'}` removed every revokable scope, so `pollWorkflow` threw
   * `FORBIDDEN "block lacks ai:write:budgeted scope"`: a Redis blip reached the SDK as a
   * permanent manifest/approval problem, whose rational response is to STOP POLLING. A
   * generation the viewer had already paid for then looked permanently broken — the exact harm
   * `block-catalog-rate-limit.ts` says never to inflict. This file's own docblock also promised
   * revocation "fails OPEN … a Redis incident must not take the bridge down", which the strip
   * had quietly made false.
   *
   * So the request is still REFUSED (fail closed) but told it is TRANSIENT.
   *
   * MUTATIONS THAT MUST KILL IT: strip instead of throwing; or throw `FORBIDDEN` instead of
   * `SERVICE_UNAVAILABLE`, which is the difference between "retry" and "give up".
   */
  it('FAILS CLOSED on an unavailable marker, as a RETRYABLE refusal', async () => {
    lookupMock.mockResolvedValue({ kind: 'unavailable' });
    await expect(
      authorizeBlockBridgeToken('tok'),
      'an unreadable marker was absorbed into a strip, so a bridge proc reports a permanent ' +
        '"block lacks <scope> scope" for a transient cache fault and the SDK stops polling a ' +
        'generation the viewer paid for'
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  /**
   * And it says so in words the client can act on — a 503 is the one tRPC 5xx whose message
   * survives `client-safe-error.ts`, which is why the code and not just the status matters.
   */
  /**
   * 🔴 THE 503 IS COUNTED, AND IT WAS OTHERWISE INVISIBLE. The throw happens before
   * `recordConsentStrip` runs and there is no bridge request counter at all, so during a cache
   * incident every bridge call 503'd while the per-scope series read a flat ZERO on
   * `surface=bridge` — the opposite of what that series' help text tells the operator to expect.
   */
  it('the unavailable refusal is counted, and not as a scope withdrawal', async () => {
    lookupMock.mockResolvedValue({ kind: 'unavailable' });
    await authorizeBlockBridgeToken('tok').catch(() => undefined);
    expect(await unavailableLabels()).toEqual([{ surface: 'bridge', value: 1 }]);
    expect(await consentLabels()).toEqual([]);
  });

  it('the unavailable refusal carries a transient, retryable message', async () => {
    lookupMock.mockResolvedValue({ kind: 'unavailable' });
    const err = await authorizeBlockBridgeToken('tok').then(
      () => null,
      (e) => e as { message: string }
    );
    expect(err?.message).toMatch(/temporarily unavailable|retry/i);
  });

  it('asks about the token’s own user and app', async () => {
    await authorizeBlockBridgeToken('tok');
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock.mock.calls[0][0]).toEqual({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
  });

  /**
   * 🔴 THE MARKER'S SET IS INTERSECTED WITH THE **TOKEN'S** SCOPES, and the fixture has to be
   * able to see that. Review measured `claims.scopes.filter((s) => revoked.has(s))` → `[...revoked]`
   * as a SURVIVING mutant: in every arm the revoked set was a subset of the token's scopes, so
   * intersection and set were the same list.
   *
   * In production they are routinely different — the marker carries the viewer's WHOLE
   * suppression list for the app, while a token is minted with whatever one page declares. The
   * mutant would emit counters for refusals that did not happen and widen the retained `scope`
   * label set with scopes this request never carried.
   */
  it('emits one counter per scope actually removed from THIS token', async () => {
    // The marker names a carried scope AND one the token was not minted with.
    lookupMock.mockResolvedValue({
      kind: 'revoked',
      scopes: new Set([POSTS, 'collections:read:private']),
    });
    await authorizeBlockBridgeToken('tok');
    expect(
      await consentLabels(),
      'the emitter reported a scope this token never carried — it is iterating the marker set ' +
        'rather than intersecting it with the token'
    ).toEqual([{ surface: 'bridge', scope: POSTS, value: 1 }]);
  });

  it('emits one per removed scope when several are removed, and none when nothing is', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS, BUZZ]) });
    await authorizeBlockBridgeToken('tok');
    expect(
      (await consentLabels()).map((l) => `${l.scope}=${l.value}`).sort(),
      'each removed scope must contribute EXACTLY one increment — a doubled inc reads identically ' +
        'once the value is dropped, which is how two such mutants survived'
    ).toEqual([`${BUZZ}=1`, `${POSTS}=1`].sort());

    client.register.resetMetrics();
    lookupMock.mockResolvedValue({ kind: 'none' });
    await authorizeBlockBridgeToken('tok');
    expect(await consentLabels()).toEqual([]);
  });
});

describe('the bridge skips the read when it cannot matter', () => {
  /**
   * An ANON token has no (user, app) pair, so no marker can exist for it — and the skip keeps
   * that population out of the fail-closed availability coupling.
   */
  it('does not consult the marker for an anon subject', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims({ sub: 'anon' }));
    const out = await authorizeBlockBridgeToken('tok');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  /**
   * A token carrying ONLY consent-exempt scopes cannot be affected by any marker:
   * `blocks.revokeScopes` refuses to record a suppression for an exempt scope, and
   * `partitionByConsent` signs them without consulting the grant at all. Measured at 20 of the
   * 29 scope-bound REST routes; the same argument holds per-token here.
   */
  it('does not consult the marker for an all-exempt token', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims({ scopes: [EXEMPT, 'apps:storage:read'] }));
    await authorizeBlockBridgeToken('tok');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('the strip runs AFTER the earlier gates', () => {
  /**
   * A revoked INSTANCE still wins, with its own message — the consent strip must not turn a
   * refusal into a served-but-narrowed request.
   */
  it('a revoked instance still throws, with its own message', async () => {
    mockIsRevoked.mockResolvedValue(true);
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
    // ⚠️ NO "the marker was not consulted" ASSERTION. It used to be here and it pinned a
    // SERIALISATION that was removed on purpose: the consent lookup is now STARTED right after
    // the token verifies, so it pipelines with `isRevoked`'s GETs instead of adding a serial
    // round trip to every bridge call — including the timer-driven `pollWorkflow`. The instance
    // refusal still wins, which is what the message above asserts.
  });

  /** A non-approved app still throws, ahead of any strip. */
  it('a non-approved app still throws', async () => {
    mockApprovalVerdict.mockResolvedValue('not_approved');
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('SEAM: through the REAL primitive', () => {
  /**
   * The arms above replace `ConsentRevocation` at the service boundary, which is right for
   * asking what the service ASKS and what it DOES with an answer — and structurally blind to the
   * primitive's own error posture. This block routes through the real `lookup` over mocked
   * Redis, so flipping that `catch` is visible here.
   */
  async function useRealPrimitive() {
    const actual = await vi.importActual<typeof ConsentRevocationModule>(
      '~/server/services/blocks/consent-revocation.service'
    );
    lookupMock.mockImplementation((opts) => actual.ConsentRevocation.lookup(opts));
  }

  it('a Redis THROW becomes a retryable refusal, through the real primitive', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockRejectedValue(new Error('connection reset'));
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('CONTROL: a marker MISS returns the full set', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(null);
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  it('a real marker strips exactly what it lists', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(JSON.stringify([BUZZ]));
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, EXEMPT]);
  });
});

/**
 * 🔴 PER-SCOPE CONSENT REVOCATION **MEETS THE PRIVATE-RUN SURFACE** — a seam neither feature
 * knew about, because they were developed on branches that were open at the same time.
 *
 * Per-scope revocation landed on `main` while the private-run branch was open. Neither side's
 * review could have looked at the other, and the interaction is NOT obvious from either:
 *
 *   - `shouldConsultMarker` keys on `{ userId, scopes }` ALONE. It does not know, and cannot
 *     ask, whether the token is an ordinary install token or a private-run review token. A
 *     private-run token has a self-bound `sub` (so `userId` is non-null) and carries
 *     non-exempt scopes, so it returns **true** and the marker IS consulted.
 *   - The marker is keyed `<userId>:<appBlockId>`, and the `userId` is the REVIEWER'S. So the
 *     rows it reads are whatever that person expressed **as an ordinary consumer of that app**,
 *     at some point in the past, on a surface that has nothing to do with review.
 *
 * ## The judgement, stated rather than left to be inferred
 *
 * This is ALLOWED TO STAND, and these rows pin it so it is a decision instead of an accident.
 * The reasoning: every arm of the interaction moves in the NARROWING direction — it can strip a
 * scope or refuse a request, never grant one — so it cannot widen what a reviewer's token can
 * do. The failure it can produce is visible and reportable ("I can't run the generation on this
 * app"), which is the same property the editor read-only strip was chosen for.
 *
 * ⚠️ IT IS STILL A SURPRISE, AND THE AUDIENCE IS THE ONE THAT FILES BUGS. A moderator who once
 * revoked `ai:write:budgeted` on this app as a consumer gets a silently read-only private run,
 * and nothing on screen says why. That is a product decision for whoever flips the flag, NOT a
 * defect to fix here — the alternative (exempting private-run tokens from the marker) means a
 * review surface deliberately ignoring a withdrawal the viewer expressed, which is strictly
 * worse than an unexplained narrowing. Recorded as a flip precondition in
 * `src/server/services/app-blocks-flag.ts`, which is where it belongs — a reader deciding
 * whether to widen the flag does not open this file.
 *
 * ## Why these are [INV], not [REG]
 *
 * Neither feature existed at the other's base, so there is no commit at which these rows can be
 * watched to fail for the right reason. They are invariant pins on a merge seam and are NOT
 * counted as regression coverage.
 */
describe('🔴 SEAM: consent revocation × the private-run surface [INV]', () => {
  const PRIVATE_RUN_CLAIMS = { privateRun: true, privateRunAudience: 'moderator' } as const;

  it('CONSULTS the marker for a private-run token — it is not exempted by the claim', async () => {
    // The load-bearing assertion is the CALL, not the result: if a future change adds a
    // `privateRun` bypass to `shouldConsultMarker`, this goes red and the exemption has to be
    // argued for rather than acquired.
    mockVerifyBlockToken.mockResolvedValue(claims(PRIVATE_RUN_CLAIMS));
    lookupMock.mockResolvedValue({ kind: 'none' });
    await authorizeBlockBridgeToken('tok');
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
  });

  it('strips a scope the REVIEWER revoked as an ordinary consumer of that app', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims(PRIVATE_RUN_CLAIMS));
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([BUZZ, EXEMPT]);
    // 🔴 AND THE PRIVATE-RUN CLAIMS SURVIVE THE STRIP. `applyRevocations` rebuilds the claims
    // object; a rebuild that dropped unknown keys would silently demote the token to an
    // ordinary one, and the NEXT thing downstream of here is the approval exemption that keeps
    // a delisted app's bridge calls alive. That failure would present as "the app loads and
    // then everything 403s", i.e. indistinguishable from the bridge-admission defect this
    // PR's round-2 review found — so it is worth its own assertion rather than being implied.
    expect(out.privateRun).toBe(true);
    expect(out.privateRunAudience).toBe('moderator');
  });

  it('🔴 CONTROL: nothing revoked ⇒ the full private-run set survives untouched', async () => {
    // Without this, a seam that returned an empty scope set for every private-run token would
    // pass the row above.
    mockVerifyBlockToken.mockResolvedValue(claims(PRIVATE_RUN_CLAIMS));
    lookupMock.mockResolvedValue({ kind: 'none' });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
    expect(out.privateRun).toBe(true);
  });

  it('fails CLOSED and RETRYABLE on an unreadable marker, private-run included', async () => {
    // The private-run surface does NOT get a weaker posture than the ordinary one. Asserted
    // because "it is only a review surface" is exactly the argument someone would make for
    // letting it through on a cache fault.
    mockVerifyBlockToken.mockResolvedValue(claims(PRIVATE_RUN_CLAIMS));
    lookupMock.mockResolvedValue({ kind: 'unavailable' });
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('a private-run token carrying ONLY exempt scopes skips the marker entirely', async () => {
    // Not a private-run property — `shouldConsultMarker`'s existing exempt rule — but pinned on
    // THIS token shape so the reachability of the arms above is not merely assumed: it shows the
    // consult decision is made from the SCOPES, which is why the arms above are reached at all.
    mockVerifyBlockToken.mockResolvedValue(claims({ ...PRIVATE_RUN_CLAIMS, scopes: [EXEMPT] }));
    const out = await authorizeBlockBridgeToken('tok');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(out.scopes).toEqual([EXEMPT]);
  });
});
