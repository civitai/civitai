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
 *   GUARD 2 — the non-moderator entitlement gate for Private / epoch resources
 *     (`if (hasPrivateOrEpoch && !opts.user.isModerator)`).
 *     Cannot currently be exercised in production at all: non-moderators cannot
 *     obtain an App Blocks dev token (`POST /api/v1/blocks/dev-token` answers
 *     "Apps are restricted to the Civitai team"), so the gate built to constrain
 *     untrusted developers is unreachable by one. A test is the only coverage
 *     available, and it keeps its value after that restriction lifts.
 *
 * 🔴 NOTHING HERE DEPENDS ON `INLINE_NODEPACKS_ENABLED`. Both `comfyregistry`
 * (source) and `nodepack` (type) are keyed off that kill switch, so a fixture
 * naming either would change verdict when the switch flips. Every AIR below uses
 * `lora` — unconditionally allowlisted in both states.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Fixture ids are PAIRWISE DISTINCT so a test cannot pass by matching the wrong
// value: every viewer id, model id and version id below appears exactly once.
const NON_MODERATOR = { id: 4242, isModerator: false };
const MODERATOR = { id: 8181, isModerator: true };

const PRIVATE_VERSION_ID = 55501;
const EPOCH_VERSION_ID = 60602;
const PUBLIC_VERSION_ID = 70703;

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
  // that can reject them. Verified live (as a moderator, against production)
  // before this file was written — all four were refused with this message.
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
      // The source guard's OWN wording, naming the offending token.
      expect(message).toBe(
        `resource AIR source '${source}' is not permitted in an inline workflow`
      );
      // …and NOT the sibling's. This is the assertion a loose
      // `/is not permitted in an inline workflow/` regex would have skipped —
      // the sibling `type` guard emits the identical tail two lines above.
      expect(message).not.toMatch(/AIR type/);

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
    expect(message).toBe("resource AIR type 'image' is not permitted in an inline workflow");
    expect(message).not.toMatch(/AIR source/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — the non-moderator Private / epoch entitlement gate.
//
//   if (hasPrivateOrEpoch && !opts.user.isModerator) { …require subscription… }
//
// Both LEGS are pinned. A test that only asserts the reject leg is killed by
// deleting the guard but NOT by dropping `!`; a test that only asserts the
// moderator exemption is killed by dropping `!` but not by deleting the guard.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertViewerEntitledToInlineResources — the non-moderator Private/epoch gate', () => {
  it('🔴 REJECT LEG — a NON-moderator with no subscription is refused a PRIVATE resource', async () => {
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

  it('🔴 REJECT LEG — the same holds for an EPOCH (early-access) resource', async () => {
    // The right-hand leg of `availability === Private || !!epochDetails`. A
    // distinct version id and a Public availability, so this case cannot be
    // satisfied by the Private branch.
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
