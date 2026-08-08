import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetResourceData = vi.fn();
const mockGetHighestTierSubscription = vi.fn();

vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...args),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...args: unknown[]) => mockGetHighestTierSubscription(...args),
}));

import { assertViewerEntitledToInlineResources } from '~/server/services/blocks/inline-comfy.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO GUARDS IN `inline-comfy.service.ts` THAT WERE LIVE BUT UNCOVERED.
 *
 * This file exists SEPARATELY from `inline-comfy.service.test.ts` on purpose: it
 * writes its OWN fixtures and shares no helper with that file, so neither suite
 * can be quietly disarmed by a change to the other's fixtures.
 *
 *   GUARD 1 — the AIR `source` allowlist (`INLINE_ALLOWED_AIR_SOURCES`).
 *     Measured before writing this: neutering that check left the whole existing
 *     suite green (35/35), and `grep` found the string `AIR source` in exactly
 *     ONE place in the repo — the service itself. No test named a source.
 *
 *     🔴 THE TRAP THIS FILE IS WRITTEN AROUND. The `type` guard sits two lines
 *     above the `source` guard and their messages share the tail
 *     `is not permitted in an inline workflow`. So a `/is not permitted/`
 *     assertion is satisfied by EITHER guard, and a fixture with a
 *     non-allowlisted TYPE is rejected before the source guard is ever reached.
 *     Every case below therefore (a) uses an ALLOWLISTED type, so the sibling
 *     cannot fire at all, and (b) asserts the source guard's own distinct
 *     wording — including that the message does NOT mention `AIR type`.
 *
 *   GUARD 2 — the SUBSCRIPTION requirement on Private / epoch resources
 *     (`if (hasPrivateOrEpoch && !opts.user.isModerator)`).
 *
 *     🔴 READ THIS BEFORE ASSUMING WHAT THESE TESTS COVER. This gate does NOT
 *     stop an untrusted developer pinning a Private resource they do not own.
 *     A DIFFERENT guard does that, one check EARLIER — `!resource.canGenerate`
 *     — and a non-owner never reaches line 452 at all. Establishing that took a
 *     live production run; two prior drafts of this comment described the wrong
 *     population, so the mechanism is written out here rather than re-guessed.
 *
 *     WHY A NON-OWNER CANNOT REACH IT (`generation.service.ts`, canGenerate):
 *       isPrivate   = availability === 'Private' || status in {Draft, Training}
 *       canGenerate = covered && hasValidStatus &&
 *                     (!isPrivate || isOwnedByUser || user.isModerator)
 *     and `getEpochDetails` returns non-null ONLY when `status !== 'Published'`,
 *     so an epoch resource is always Draft/Training. Therefore EVERY resource
 *     that can set `hasPrivateOrEpoch` also sets `isPrivate` — which forces
 *     `canGenerate = false` for a non-owner non-moderator, and the canGenerate
 *     guard throws before `hasPrivateOrEpoch` is ever computed.
 *
 *     🔴 SO WHAT LINE 452 ACTUALLY GATES: the OWNER of a Private/epoch resource
 *     who lacks an active subscription. Owners get `canGenerate: true` on their
 *     own private resources, so they are the population that arrives here.
 *     Moderators are exempt at BOTH layers.
 *
 *     That is exactly what the fixtures below encode, and it is why they are
 *     correct as written: a row with `availability: 'Private'` AND
 *     `canGenerate: true` for a non-moderator viewer IS the owner case. Keep
 *     them; only the description of the population was ever wrong.
 *
 *     🔴 ESTABLISHED BY LIVE MEASUREMENT, NOT INFERENCE — and note HOW, because
 *     the obvious method does not work. A genuine non-moderator (author-cohort
 *     enrolled) submitted an inline body pinning a Private version owned by
 *     someone else: 403, zero Buzz. Positive control — byte-identical body, one
 *     AIR swapped for a public version — 200, workflow minted. But the MESSAGE
 *     could not attribute the refusal: the anti-drop guard and the canGenerate
 *     guard emit VERBATIM IDENTICAL text (`model version <id> is not available
 *     for generation`), so the response cannot say which fired. It was
 *     discriminated by a MODERATOR CONTRAST on the identical negative body (200,
 *     accepted): `resourceDataCache`'s lookup takes only ids and filters on
 *     `mv.id IN (…)` alone — no status, no availability, no user parameter — so
 *     row PRESENCE is user-independent. A moderator succeeding proves the row
 *     was there, which excludes anti-drop and leaves canGenerate.
 *
 *     🔴 KNOWN LIMIT — THE SUBSCRIPTION BRANCH ITSELF HAS STILL NEVER EXECUTED
 *     IN A NON-MODERATOR PRODUCTION RUN. The test account owns zero models, so
 *     the owner-without-subscription case could not be constructed live. Its
 *     reachability is established from the source above; its BEHAVIOUR is
 *     pinned only by the fixtures below. Do not upgrade that to "verified in
 *     production" without an owning account.
 *
 *     (Reachability of the App Blocks path at all: `isAppBlocksAuthorEnabled`
 *     is a moderator floor OR a per-user eval of `app-blocks-author`, whose
 *     rollout carries a curated non-moderator author cohort — see
 *     `server/services/app-blocks-flag.ts` and the mint endpoint's own comment
 *     at `pages/api/v1/blocks/dev-token.ts`. An earlier draft claimed
 *     non-moderators cannot obtain a dev token at all; that was false, and was
 *     derived by generalising ONE account's 403 — from an endpoint that returns
 *     the SAME body from its banned branch and its author gate, so it could not
 *     attribute even that one rejection.)
 *
 * 🔴 NOTHING HERE DEPENDS ON `INLINE_NODEPACKS_ENABLED`. Both `comfyregistry`
 * (source) and `nodepack` (type) are keyed off that kill switch, so a fixture
 * naming either would change verdict when the switch flips. Every AIR below uses
 * `lora` — unconditionally allowlisted in both states.
 *
 * 🔴 WHAT KIND OF COVERAGE THIS IS, STATED HONESTLY. Both guards are live and
 * CORRECT today, so every case here is green at the base ref and green at HEAD.
 * None of it is regression coverage in the strict sense — there is no revision
 * at which one of these went red. They are MUTATION-KILLED INVARIANT GUARDS:
 * their worth is the recorded fact that breaking each guard makes a NAMED case
 * fail for THAT guard's own reason, not a red-to-green transition. The mutation
 * table lives in the PR description; do not restate it here, where it will rot.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Fixture ids are PAIRWISE DISTINCT so a test cannot pass by matching the wrong
// value: every viewer id, model id and version id below appears exactly once.
const NON_MODERATOR = { id: 4242, isModerator: false };
const MODERATOR = { id: 8181, isModerator: true };

const PRIVATE_VERSION_ID = 55501;
const EPOCH_VERSION_ID = 60602;
const PUBLIC_VERSION_ID = 70703;
const UPPERCASE_VERSION_ID = 80804;

const PRIVATE_AIR = `urn:air:zeta:lora:civitai:31337@${PRIVATE_VERSION_ID}`;
const EPOCH_AIR = `urn:air:eta:lora:civitai:31338@${EPOCH_VERSION_ID}`;
const PUBLIC_AIR = `urn:air:theta:lora:civitai:31339@${PUBLIC_VERSION_ID}`;

/**
 * A `getResourceData` row shaped like the real return. Defaults are the fully
 * BENIGN case — resolvable, generatable, no substitute, Public, no epoch — so
 * that any rejection in a test below is attributable to the ONE field that test
 * overrode, and never to a fixture that happened to trip an earlier gate.
 */
function row(over: Record<string, unknown> = {}) {
  return {
    id: PUBLIC_VERSION_ID,
    name: 'fixture resource',
    canGenerate: true,
    availability: 'Public',
    ...over,
  };
}

/**
 * Capture a rejection so the test can assert on the CODE and the EXACT message
 * rather than a regex a sibling guard could also satisfy.
 *
 * 🔴 It THROWS a distinctive error when the call RESOLVES. That is the shape a
 * removed guard produces, and it must be loud: a `.rejects` matcher that never
 * runs is the classic vacuous pass.
 */
async function captureRejection(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: String(err.message ?? e) };
  }
  throw new Error('expected assertViewerEntitledToInlineResources to REJECT, but it RESOLVED');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResourceData.mockResolvedValue([row()]);
  mockGetHighestTierSubscription.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 1 — the AIR `source` allowlist.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertViewerEntitledToInlineResources — the AIR `source` allowlist', () => {
  // Each of these four names an ALLOWLISTED type (`lora`), so the sibling type
  // guard is structurally unable to fire: the source guard is the only thing
  // that can reject them. All four were also confirmed refused with this exact
  // message against the live endpoint (from a moderator session) — a check on
  // THESE four tokens, which is all it licenses; see the KNOWN LIMIT below.
  const REJECTED_SOURCES = ['replicate', 'openai', 's3', 'evilhost'] as const;

  for (const source of REJECTED_SOURCES) {
    it(`🔴 rejects a NON-allowlisted source '${source}' behind an ALLOWLISTED type`, async () => {
      const { code, message } = await captureRejection(
        assertViewerEntitledToInlineResources({
          airs: [`urn:air:zeta:lora:${source}:kappa/lambda@71`],
          user: NON_MODERATOR,
        })
      );

      expect(code).toBe('BAD_REQUEST');
      // The source guard's OWN wording, naming the offending token. The EXACT
      // equality is what does the work: it is the assertion a loose
      // `/is not permitted in an inline workflow/` regex would have skipped,
      // because the sibling `type` guard emits that identical tail two lines
      // above. (An additional `not.toMatch(/AIR type/)` used to sit here — it
      // was DEAD: after an exact `toBe` on a fixed string it can never fail
      // independently. Removed rather than kept as decorative defence.)
      expect(message).toBe(
        `resource AIR source '${source}' is not permitted in an inline workflow`
      );

      // Nothing downstream ran: rejection happened during AIR parsing, before
      // the entitlement belt was consulted.
      expect(mockGetResourceData).not.toHaveBeenCalled();
    });
  }

  it('POSITIVE CONTROL — the SAME AIR with an allowlisted `huggingface` source is accepted', async () => {
    // Isolates the source token as the cause. Identical ecosystem (`zeta`),
    // identical type (`lora`), identical id (`kappa/lambda`) and version (`71`)
    // as the rejected fixtures above — only the source segment differs, and the
    // rejection disappears. Without this control, those cases are equally
    // satisfied by a guard rejecting every `kappa/lambda@71` for some other
    // reason.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:zeta:lora:huggingface:kappa/lambda@71'],
        user: NON_MODERATOR,
      })
    ).resolves.toBeUndefined();
    // A huggingface AIR carries no civitai entitlement, so the belt is not
    // consulted — exempt by construction, not by an accidental early return.
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — an allowlisted `civitai` source proceeds INTO the entitlement belt', async () => {
    // The other half of the allowlist. `huggingface` passes by returning early;
    // `civitai` must pass by being GATED. Asserting the belt was called with the
    // parsed version id is what distinguishes the two.
    mockGetResourceData.mockResolvedValue([row({ id: PUBLIC_VERSION_ID })]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [PUBLIC_AIR], user: NON_MODERATOR })
    ).resolves.toBeUndefined();
    expect(mockGetResourceData).toHaveBeenCalledWith([PUBLIC_VERSION_ID], expect.anything());
  });

  it('ORDER PIN — a fixture failing BOTH allowlists is rejected on TYPE, not on source', async () => {
    // The measured evaluation order (type guard, then source guard) is what
    // makes the "allowlisted type" precondition on every case above load-bearing
    // rather than decorative. If this ever flips, the cases above would start
    // being satisfiable by the sibling and this pin goes red first.
    const { message } = await captureRejection(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:sigma:image:replicate:tau/upsilon@75'],
        user: NON_MODERATOR,
      })
    );
    // Exact equality again — a `not.toMatch(/AIR source/)` after it would be
    // dead for the same reason as above.
    expect(message).toBe("resource AIR type 'image' is not permitted in an inline workflow");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 CASE-FOLDING. `parseInlineAir` lowercases `source` before BOTH the
  // allowlist test and the `source !== 'civitai'` branch. The service's own doc
  // calls a case-SENSITIVE comparison here "a direct bypass", so dropping that
  // `.toLowerCase()` is the highest-value mutation on this guard — and until
  // these two cases existed, this file did not catch it at all (every fixture
  // above is already lowercase, so it survived 13/13). Both consequences of the
  // fold are pinned, because they fail in OPPOSITE directions.
  //
  // 🔴 SCOPE — ONLY THE `source` FOLD IS PINNED, NOT BOTH. `parseInlineAir`
  // folds `type` one line ABOVE the `source` fold, and that sibling fold still
  // survives both suites. It is left uncovered deliberately, not by oversight:
  // its failure direction is fail-CLOSED (drop it and an uppercase `LORA` starts
  // being REJECTED — over-strictness, a false reject), which is the safe
  // direction, whereas the `source` fold guards a routing decision. Do not read
  // "case-folding is covered" off this block; read "the source fold is".
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 CASE-FOLD (reject side) — an UPPERCASE non-allowlisted source is rejected, named LOWERCASED', async () => {
    // Without the fold this still rejects — but the message names `REPLICATE`.
    // Asserting the lowercased token is what makes the fold observable here
    // rather than incidental.
    const { code, message } = await captureRejection(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:zeta:lora:REPLICATE:kappa/lambda@71'],
        user: NON_MODERATOR,
      })
    );
    expect(code).toBe('BAD_REQUEST');
    expect(message).toBe("resource AIR source 'replicate' is not permitted in an inline workflow");
  });

  it('🔴 CASE-FOLD (bypass side) — an UPPERCASE `CIVITAI` source still enters the entitlement belt', async () => {
    // A case-sensitive `source !== 'civitai'` would send this down the
    // non-civitai branch and return BEFORE any entitlement check — a gated
    // resource waved through by spelling. Asserting the belt was CALLED (not
    // merely that this resolves) is what distinguishes "gated and allowed" from
    // "never gated", and that assertion is the load-bearing one: a mutant that
    // inverts the routing so the belt is skipped turns this case red.
    //
    // 🔴 BE PRECISE ABOUT WHICH MUTATION THIS CATCHES — an earlier version of
    // this comment called it "THE ACTUAL BYPASS", which overstated what ONE
    // change does. Dropping only `.toLowerCase()` on `source` does NOT open the
    // bypass: the allowlist test folds on the adjacent line and catches
    // `CIVITAI` first, so the request is REJECTED — fail-CLOSED over-strictness,
    // not a hole. Reaching the routing bypass takes TWO changes (fold dropped
    // AND the allowlist made case-insensitive or widened). This case still dies
    // under the single-change mutant, but it dies at the ALLOWLIST, so do not
    // read its redness as evidence about the routing branch.
    mockGetResourceData.mockResolvedValue([row({ id: UPPERCASE_VERSION_ID })]);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: [`urn:air:zeta:lora:CIVITAI:31340@${UPPERCASE_VERSION_ID}`],
        user: NON_MODERATOR,
      })
    ).resolves.toBeUndefined();
    expect(mockGetResourceData).toHaveBeenCalledWith([UPPERCASE_VERSION_ID], expect.anything());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 KNOWN LIMIT — READ THIS BEFORE CONCLUDING "the source allowlist is
  // covered". The four cases above are a REJECTION sample, not a membership
  // pin. They catch a widening only if it happens to collide with one of the
  // four tokens they name: adding an UNFIXTURED token (say `evil-cdn`) to
  // `INLINE_ALLOWED_AIR_SOURCES` leaves this file green at full count, and the
  // sibling suite green too. The complementary assertion — pinning the SET's
  // exact membership, so any addition or removal goes red — is deliberately not
  // duplicated here (it lands in the follow-up PR that owns it); until that
  // merges, treat this file as pinning "these four are refused, with this
  // wording", nothing wider.
  // ───────────────────────────────────────────────────────────────────────────
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — the SUBSCRIPTION requirement on a Private / epoch resource the
// viewer can already generate with, i.e. ITS OWNER.
//
//   if (hasPrivateOrEpoch && !opts.user.isModerator) { …require subscription… }
//
// 🔴 THE POPULATION IS OWNERS, NOT ARBITRARY DEVELOPERS. A non-owner is refused
// one guard EARLIER by `!resource.canGenerate` and never arrives here — see the
// derivation in the file header. Every fixture below therefore pairs
// `availability: 'Private'` (or an epoch) with `canGenerate: true`, which is the
// shape production produces for an OWNER. That is deliberate, not a convenient
// mock: with `canGenerate: false` these cases would be rejected by the earlier
// guard and would prove nothing about this one.
//
// Both LEGS are pinned. A test that only asserts the reject leg is killed by
// deleting the guard but NOT by dropping `!`; a test that only asserts the
// moderator exemption is killed by dropping `!` but not by deleting the guard.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertViewerEntitledToInlineResources — the owner Private/epoch subscription gate', () => {
  it('🔴 REJECT LEG — a NON-moderator OWNER with no subscription is refused their PRIVATE resource', async () => {
    mockGetResourceData.mockResolvedValue([
      row({ id: PRIVATE_VERSION_ID, availability: 'Private' }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    const { code, message } = await captureRejection(
      assertViewerEntitledToInlineResources({ airs: [PRIVATE_AIR], user: NON_MODERATOR })
    );

    expect(code).toBe('FORBIDDEN');
    // EXACT, not a regex. Three OTHER FORBIDDEN messages are reachable from this
    // same function ("is not available for generation", "never silently
    // substituted", "epoch that has expired"); an exact match is what proves
    // THIS gate rejected, and the control below proves none of those could have.
    expect(message).toBe('Using Private resources requires an active subscription.');
    // The gate was genuinely REACHED and consulted the subscription service for
    // THIS viewer — not short-circuited somewhere earlier.
    expect(mockGetHighestTierSubscription).toHaveBeenCalledWith(NON_MODERATOR.id);
  });

  it('🔴 MIXED MANIFEST — ONE Private resource among Public ones still rejects (`.some`, not `.every`)', async () => {
    // 🔴 THE FIXTURE SHAPE IS THE ASSERTION HERE. `hasPrivateOrEpoch` is a
    // `.some` over the returned rows. Every OTHER fixture in this file and in
    // the sibling suite is SINGLE-RESOURCE — and on a one-element array `.some`
    // and `.every` are INDISTINGUISHABLE. So `.some` → `.every` was a live
    // fail-OPEN that both suites passed 50/50: with `.every`, a manifest mixing
    // one Private resource with any Public one reports "no private resources
    // here" and the entitlement gate never runs.
    //
    // That is the real-world shape too — an inline graph declaring a Private
    // LoRA alongside a public checkpoint — and it fails OPEN on a Buzz-spending
    // path, so it is the direction that matters. No assertion could have caught
    // it; only a second element in the array can.
    mockGetResourceData.mockResolvedValue([
      row({ id: PUBLIC_VERSION_ID, availability: 'Public' }),
      row({ id: PRIVATE_VERSION_ID, availability: 'Private' }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    const { code, message } = await captureRejection(
      assertViewerEntitledToInlineResources({
        airs: [PUBLIC_AIR, PRIVATE_AIR],
        user: NON_MODERATOR,
      })
    );

    expect(code).toBe('FORBIDDEN');
    expect(message).toBe('Using Private resources requires an active subscription.');
    expect(mockGetHighestTierSubscription).toHaveBeenCalledWith(NON_MODERATOR.id);
  });

  it('🔴 REJECT LEG — the same holds for an OWNED EPOCH (early-access) resource', async () => {
    // The right-hand leg of `availability === Private || !!epochDetails`. A
    // distinct version id and a Public availability, so this case cannot be
    // satisfied by the Private branch. (In production an epoch resource is
    // always Draft/Training — `getEpochDetails` returns non-null only when
    // `status !== 'Published'` — which is itself `isPrivate`, so this row's
    // `canGenerate: true` again encodes the OWNER.)
    mockGetResourceData.mockResolvedValue([
      row({
        id: EPOCH_VERSION_ID,
        availability: 'Public',
        epochDetails: { epochNumber: 5, isExpired: false },
      }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    const { code, message } = await captureRejection(
      assertViewerEntitledToInlineResources({ airs: [EPOCH_AIR], user: NON_MODERATOR })
    );

    expect(code).toBe('FORBIDDEN');
    expect(message).toBe('Using Private resources requires an active subscription.');
    expect(mockGetHighestTierSubscription).toHaveBeenCalledWith(NON_MODERATOR.id);
  });

  it('🔴 EXEMPT LEG — a MODERATOR passes the same PRIVATE fixture with no subscription', async () => {
    mockGetResourceData.mockResolvedValue([
      row({ id: PRIVATE_VERSION_ID, availability: 'Private' }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await expect(
      assertViewerEntitledToInlineResources({ airs: [PRIVATE_AIR], user: MODERATOR })
    ).resolves.toBeUndefined();
    // Not merely "allowed": the subscription lookup was never even attempted,
    // which is what `!opts.user.isModerator` short-circuiting actually does.
    expect(mockGetHighestTierSubscription).not.toHaveBeenCalled();
  });

  it('🔴 EXEMPT LEG — a MODERATOR passes the same EPOCH fixture with no subscription', async () => {
    mockGetResourceData.mockResolvedValue([
      row({
        id: EPOCH_VERSION_ID,
        availability: 'Public',
        epochDetails: { epochNumber: 5, isExpired: false },
      }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await expect(
      assertViewerEntitledToInlineResources({ airs: [EPOCH_AIR], user: MODERATOR })
    ).resolves.toBeUndefined();
    expect(mockGetHighestTierSubscription).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a NON-moderator WITH a subscription passes the PRIVATE fixture', async () => {
    // Isolates "no subscription" as the cause of the reject-leg rejection. If
    // this also rejected, the reject-leg cases would be proving nothing about
    // the subscription requirement.
    mockGetResourceData.mockResolvedValue([
      row({ id: PRIVATE_VERSION_ID, availability: 'Private' }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue({ id: 'sub_fixture', tier: 'gold' });

    await expect(
      assertViewerEntitledToInlineResources({ airs: [PRIVATE_AIR], user: NON_MODERATOR })
    ).resolves.toBeUndefined();
    expect(mockGetHighestTierSubscription).toHaveBeenCalledWith(NON_MODERATOR.id);
  });

  it('🔴 GUARD-ATTRIBUTION CONTROL — the same NON-moderator + no subscription passes a PUBLIC, non-epoch resource', async () => {
    // This is the control that stops a green for the wrong reason. The nearby
    // `canGenerate` / anti-drop / anti-substitute checks are NOT moderator-gated
    // and reject with their own FORBIDDEN. This case holds the viewer, the
    // subscription state and the row shape fixed and changes ONLY
    // availability/epoch — and it passes. So the rejections above cannot have
    // come from those checks; the only thing that changed is what
    // `hasPrivateOrEpoch` evaluates to.
    mockGetResourceData.mockResolvedValue([row({ id: PUBLIC_VERSION_ID, availability: 'Public' })]);
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await expect(
      assertViewerEntitledToInlineResources({ airs: [PUBLIC_AIR], user: NON_MODERATOR })
    ).resolves.toBeUndefined();
    expect(mockGetHighestTierSubscription).not.toHaveBeenCalled();
  });
});
