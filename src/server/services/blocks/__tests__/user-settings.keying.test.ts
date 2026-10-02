import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');

/**
 * PER-VIEWER CHECKPOINT OVERRIDE — THE KEYING, PINNED.
 *
 * `block_user_settings` is keyed `@@id([block_instance_id, user_id])`, and
 * `resolveBlockCheckpoint` reads it back on that same composite key at every generation.
 * So the write and the read agree only as long as BOTH halves of the key are derived the
 * same way — and the way they are derived is the invariant this file exists to hold:
 *
 *   `blockInstanceId` ← `claims.blockInstanceId`   (the VERIFIED token, never the payload)
 *   `userId`          ← `parseSubjectUserId(claims.sub)`  (likewise)
 *
 * 🔴 WHY THIS MATTERS NOW. Until this change there was ONE transport, so there was nothing
 * for the keying to disagree WITH. There are now two — `trpc.blocks.updateUserSettings` and
 * `POST /api/v1/blocks/user-checkpoint/set` — and a REST route is exactly the place a
 * `blockInstanceId` or `userId` parameter gets added, because REST callers are used to
 * naming their own resources. An override written under a caller-supplied key would leak
 * across installs (or across viewers) while still looking correct to whoever wrote it: the
 * write succeeds, returns `{ ok: true }`, and the value simply never comes back out of
 * `resolveBlockCheckpoint`, or comes back for the wrong person.
 *
 * 🔴 LABEL: THESE ARE INVARIANT GUARDS, NOT REGRESSION COVERAGE, and the distinction is not
 * cosmetic. The keying behaviour is UNCHANGED by this PR — it was already correct inside
 * `blocks.updateUserSettings`, and no bug ever violated it. These tests cannot be shown to
 * fail on pre-change code, because the module they import did not exist there. What they
 * pin is a property the new transport makes newly BREAKABLE. They are mutation-tested
 * instead (see the PR body for the matrix), which is the only evidence available for a
 * guard of this shape.
 *
 * 🔴 THE FIXTURE CONSTANTS ARE PAIRWISE DISTINCT, AND DISTINCT FROM EVERY VALUE THE
 * ASSERTIONS NAME. That is load-bearing rather than tidy. If the token's instance id and
 * the payload's decoy shared a value — or if `userId` happened to equal `modelId` — a
 * mutant that read the wrong one would produce the right answer and SURVIVE a fully green
 * run. Every id below is a different literal, and the payload deliberately carries decoys
 * spelling the SAME field names the real key uses, so "the body is ignored" is tested
 * rather than assumed.
 */

const TOKEN_INSTANCE_ID = 'mbi_from_verified_token';
/** The decoy. A caller-supplied instance id that must never reach the write. */
const PAYLOAD_INSTANCE_ID = 'mbi_supplied_by_caller';
const TOKEN_USER_ID = 7717;
/** The decoy. A caller-supplied user id that must never reach the write. */
const PAYLOAD_USER_ID = 9931;
const CTX_MODEL_ID = 4242;
const CTX_SLOT_ID = 'model-detail-below';
const APP_BLOCK_ID = 'apb_keying_fixture';
const CHECKPOINT_VERSION_ID = 8080;
const BASE_MODEL = 'Flux.1 D';

const h = vi.hoisted(() => ({
  assertAppBlocksEnabled: vi.fn(),
  getSessionUserById: vi.fn(),
  isAppBlocksAuthorEnabled: vi.fn(),
  resolveBlockInstance: vi.fn(),
  upsertUserSettings: vi.fn(),
  validateBlockSettings: vi.fn(),
  getRepresentativeBaseModel: vi.fn(),
  validateBlockCheckpoint: vi.fn(),
  recordScopeInvocation: vi.fn(),
  authorizeBlockBridgeToken: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-token-access.service', () => ({
  assertAppBlocksEnabledForTokenUser: h.assertAppBlocksEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: h.getSessionUserById },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: h.isAppBlocksAuthorEnabled,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    resolveBlockInstance: h.resolveBlockInstance,
    upsertUserSettings: h.upsertUserSettings,
  },
}));
vi.mock('~/server/services/blocks/settings-validator.service', () => ({
  validateBlockSettings: h.validateBlockSettings,
}));
vi.mock('~/server/services/blocks/checkpoint.service', () => ({
  getRepresentativeBaseModel: h.getRepresentativeBaseModel,
  validateBlockCheckpoint: h.validateBlockCheckpoint,
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: h.recordScopeInvocation,
}));
vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: h.authorizeBlockBridgeToken,
}));

// 🔴 `parseSubjectUserId` IS NOT MOCKED, AND THAT IS DELIBERATE. It is one of the two
// derivations under test — half the keying is literally "whatever this function returns for
// `claims.sub`". A stub would make every `userId` assertion below a restatement of the
// stub's own return value, which is the "never derive a test's expectation from the
// implementation" failure in its most direct form. The real one is imported and used, so
// the subject-parsing rules (including the anon sentinel) are exercised as shipped.
import {
  setUserCheckpointOverride,
  updateBlockUserSettingsFromClaims,
  userCheckpointSetInput,
  VIEWER_CHECKPOINT_SETTINGS_KEY,
} from '~/server/services/blocks/user-settings.service';

type AnyClaims = Parameters<typeof updateBlockUserSettingsFromClaims>[0]['claims'];

function claimsFixture(overrides: Record<string, unknown> = {}): AnyClaims {
  return {
    // The REAL wire format (`USER_SUB_RE` = /^user:[1-9][0-9]{0,11}$/). Spelled out rather
    // than built from a helper: `parseSubjectUserId` is unmocked here precisely so the
    // format is exercised, and a fixture that fabricated a bare `'7717'` would be rejected
    // as a malformed claim — which is how this fixture was first written, and how the
    // unmocked parser earned its keep.
    sub: `user:${TOKEN_USER_ID}`,
    blockInstanceId: TOKEN_INSTANCE_ID,
    appBlockId: APP_BLOCK_ID,
    ctx: { modelId: CTX_MODEL_ID, slotId: CTX_SLOT_ID },
    ...overrides,
  } as unknown as AnyClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assertAppBlocksEnabled.mockResolvedValue(undefined);
  h.getSessionUserById.mockResolvedValue({ id: TOKEN_USER_ID, isModerator: false });
  h.isAppBlocksAuthorEnabled.mockResolvedValue(true);
  h.resolveBlockInstance.mockResolvedValue({
    appBlock: { manifest: { settings: {} }, approvedScopes: [] },
  });
  // Pass-through: the manifest filter has its own coverage, and stubbing it to drop fields
  // here would make the keying assertions unreachable rather than stronger.
  h.validateBlockSettings.mockImplementation(
    (args: { inputSettings: Record<string, unknown> }) => args.inputSettings
  );
  h.getRepresentativeBaseModel.mockResolvedValue(BASE_MODEL);
  h.validateBlockCheckpoint.mockResolvedValue({ versionId: CHECKPOINT_VERSION_ID });
  h.upsertUserSettings.mockResolvedValue(undefined);
  h.recordScopeInvocation.mockResolvedValue(undefined);
  h.authorizeBlockBridgeToken.mockResolvedValue(claimsFixture());
});

describe('the checkpoint-override write is keyed on the VERIFIED TOKEN, not the payload', () => {
  it('writes (blockInstanceId, userId) taken from the claims', async () => {
    await updateBlockUserSettingsFromClaims({
      claims: claimsFixture(),
      settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
    });

    expect(h.upsertUserSettings).toHaveBeenCalledTimes(1);
    expect(h.upsertUserSettings).toHaveBeenCalledWith({
      blockInstanceId: TOKEN_INSTANCE_ID,
      userId: TOKEN_USER_ID,
      settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
    });
  });

  it('IGNORES a blockInstanceId and a userId spelled in the settings payload', async () => {
    // The shape a REST caller would naturally send if the route took resource ids. Both
    // decoys use the EXACT field names the real key uses, so a body that reached the write
    // would be indistinguishable from the token-derived value except by its VALUE — which is
    // why the two are different literals.
    await updateBlockUserSettingsFromClaims({
      claims: claimsFixture(),
      settings: {
        [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID,
        blockInstanceId: PAYLOAD_INSTANCE_ID,
        userId: PAYLOAD_USER_ID,
      },
    });

    const call = h.upsertUserSettings.mock.calls[0][0] as {
      blockInstanceId: string;
      userId: number;
    };
    expect(call.blockInstanceId).toBe(TOKEN_INSTANCE_ID);
    expect(call.blockInstanceId).not.toBe(PAYLOAD_INSTANCE_ID);
    expect(call.userId).toBe(TOKEN_USER_ID);
    expect(call.userId).not.toBe(PAYLOAD_USER_ID);
  });

  it('resolves the install against the SAME instance id it writes under', async () => {
    // The two must not be allowed to drift apart: resolving install A and writing row B
    // would pass every assertion that looked at only one of them.
    await updateBlockUserSettingsFromClaims({
      claims: claimsFixture(),
      settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
    });

    const resolved = h.resolveBlockInstance.mock.calls[0][0] as {
      blockInstanceId: string;
      viewerUserId: number;
      modelId: number;
      slotId: string;
    };
    const written = h.upsertUserSettings.mock.calls[0][0] as {
      blockInstanceId: string;
      userId: number;
    };
    expect(resolved.blockInstanceId).toBe(written.blockInstanceId);
    expect(resolved.viewerUserId).toBe(written.userId);
    // MODEL-BOUND: the tuple the install is re-validated against comes from the token ctx.
    expect(resolved.modelId).toBe(CTX_MODEL_ID);
    expect(resolved.slotId).toBe(CTX_SLOT_ID);
  });

  it('the REST adapter reaches the same write under the same key', async () => {
    // `setUserCheckpointOverride` is the REST entry point. It must not introduce a second
    // spelling of either the key or the settings field.
    await setUserCheckpointOverride('tok_rest', CHECKPOINT_VERSION_ID);

    expect(h.authorizeBlockBridgeToken).toHaveBeenCalledWith('tok_rest');
    expect(h.upsertUserSettings).toHaveBeenCalledWith({
      blockInstanceId: TOKEN_INSTANCE_ID,
      userId: TOKEN_USER_ID,
      settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
    });
  });

  it('the settings FIELD NAME is the one EVERY reader actually destructures', () => {
    // 🔴 THIS GUARD PINS A RELATIONSHIP, AND ITS FIRST VERSION DID NOT. That version asserted
    // only `VIEWER_CHECKPOINT_SETTINGS_KEY === 'checkpoint_version_id'` — two expectations on
    // the constant, touching NEITHER reader. Its NAME claimed a relationship while its BODY
    // inspected one side, so it could not fail for the drift it was named after: rename the
    // key at a reader and this test, the service and all 32 cases stay green while every
    // stored override silently stops resolving. Caught by the round-0 audit of #5093.
    //
    // 🔴 AND THE KEY IS NOT "NAMED ONCE": it is open-coded in production at THREE sites, none
    // of which imports the constant. Two of them are READERS — and the fact that there are
    // two at all is worth seeing: `resolveBlockCheckpoint` has a near-duplicate in
    // `block-registry.service.ts`. Both are asserted, so a rename that misses either fails
    // here rather than in production.
    //
    // Asserted by READING THE SOURCE rather than importing it: these modules pull in the
    // Prisma client and the Redis client at import time, which a unit test must not do. It is
    // a text check and therefore weaker than a call — but it is strictly stronger than the
    // constant-only version it replaces, and it fails in the direction that matters.
    const readers = [
      'src/server/services/blocks/checkpoint.service.ts',
      'src/server/services/block-registry.service.ts',
    ];
    for (const rel of readers) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      // POSITIVE CONTROL: the file must contain the viewer-override read at all, so a moved
      // or renamed reader fails LOUDLY here instead of leaving a vacuous zero-match pass.
      expect(src, `${rel} must still read a viewer override`).toContain(
        `{ ${VIEWER_CHECKPOINT_SETTINGS_KEY}?: unknown }`
      );
      expect(
        src.includes(`viewerRaw.${VIEWER_CHECKPOINT_SETTINGS_KEY}`),
        `${rel} must destructure the viewer key as ${VIEWER_CHECKPOINT_SETTINGS_KEY}`
      ).toBe(true);
    }

    // The literal, spelled out: a mutant that renamed the constant would otherwise rename
    // every expectation above with it and survive.
    expect(VIEWER_CHECKPOINT_SETTINGS_KEY).toBe('checkpoint_version_id');
    // The publisher's parallel key is deliberately NOT it — writing an override under
    // `default_checkpoint_version_id` would resolve as "no override" forever.
    expect(VIEWER_CHECKPOINT_SETTINGS_KEY).not.toBe('default_checkpoint_version_id');
  });

  it('the BRIDGE writer spells the key the same way the REST writer does', () => {
    // `IframeHost.tsx` builds `{ checkpoint_version_id: versionId }` by hand rather than
    // importing the constant (it is a client component; importing a server service would drag
    // the server graph into the browser bundle). That hand-spelling is the one place the two
    // transports could silently disagree about WHICH FIELD they write, which is the same class
    // of divergence the shared body exists to prevent — so it is pinned rather than trusted.
    const src = readFileSync(join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx'), 'utf8');
    expect(src).toContain(`settings: { ${VIEWER_CHECKPOINT_SETTINGS_KEY}: versionId }`);
  });
});

describe('clearing the override', () => {
  it('persists an explicit null WITHOUT running checkpoint validation', async () => {
    // `persist(null)` is the SDK's documented clear. It must reach the row (so the stored
    // override is actually removed) but must NOT be validated as a checkpoint — there is no
    // version to validate, and validating would reject the clear.
    await setUserCheckpointOverride('tok_rest', null);

    expect(h.validateBlockCheckpoint).not.toHaveBeenCalled();
    expect(h.upsertUserSettings).toHaveBeenCalledWith({
      blockInstanceId: TOKEN_INSTANCE_ID,
      userId: TOKEN_USER_ID,
      settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: null },
    });
  });

  it('a non-null versionId IS validated, against the bound model’s base model', async () => {
    // The positive control for the assertion above: if validation never ran for EITHER
    // case, the `not.toHaveBeenCalled()` there would be vacuous.
    await setUserCheckpointOverride('tok_rest', CHECKPOINT_VERSION_ID);

    expect(h.getRepresentativeBaseModel).toHaveBeenCalledWith(CTX_MODEL_ID);
    expect(h.validateBlockCheckpoint).toHaveBeenCalledWith({
      checkpointVersionId: CHECKPOINT_VERSION_ID,
      forBaseModel: BASE_MODEL,
      reason: 'viewer-override',
    });
  });
});

describe('the refusals both transports share', () => {
  it('refuses an ANONYMOUS subject — there is no user_id to key the row on', async () => {
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture({ sub: 'anon' }),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a token with NO modelId ctx — the page-token case (gotcha-#73)', async () => {
    // This is the SERVER half of the contract `PageBlockHostSetUserCheckpoint.browser.test.tsx`
    // pins on the client half. The page host NACKs in-host precisely because this body would
    // refuse a page token (`entityType:'none'`, no modelId) anyway. If this stopped throwing,
    // that test's stated premise would be silently false.
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture({ ctx: { slotId: CTX_SLOT_ID } }),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a token with no slotId ctx', async () => {
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture({ ctx: { modelId: CTX_MODEL_ID } }),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('refuses when the install does not resolve — synthetic ids fail CLOSED', async () => {
    h.resolveBlockInstance.mockResolvedValue(null);
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture(),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a subject that does not hydrate, BEFORE the capability is evaluated', async () => {
    h.getSessionUserById.mockResolvedValue(null);
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture(),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Structural, not derived from the flag: no subject ⇒ no Flipt call at all.
    expect(h.isAppBlocksAuthorEnabled).not.toHaveBeenCalled();
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a NON-AUTHOR viewer — the gate REST inherits from the bridge unchanged', async () => {
    // 🔴 This is the semantic that keeps the shipped consumer's "session only" note alive for
    // ordinary viewers, and it is pinned here so that a future change to it is a DELIBERATE
    // policy change on BOTH transports rather than a quiet divergence on one.
    h.isAppBlocksAuthorEnabled.mockResolvedValue(false);
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture(),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });

  it('the app-blocks kill switch runs and can refuse', async () => {
    h.assertAppBlocksEnabled.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' })
    );
    await expect(
      updateBlockUserSettingsFromClaims({
        claims: claimsFixture(),
        settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: CHECKPOINT_VERSION_ID },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.upsertUserSettings).not.toHaveBeenCalled();
  });
});

describe('the REST wire schema', () => {
  it('accepts a positive integer and an explicit null', () => {
    expect(userCheckpointSetInput.safeParse({ versionId: 12 }).success).toBe(true);
    expect(userCheckpointSetInput.safeParse({ versionId: null }).success).toBe(true);
  });

  it('REJECTS a MISSING versionId — "clear it" must not be spelled the same as "I forgot"', () => {
    // The field is nullable, NOT optional, and that is the whole reason: an absent field
    // resolving to `null` would turn a malformed request into a silent override WIPE.
    expect(userCheckpointSetInput.safeParse({}).success).toBe(false);
  });

  it('rejects non-integer, zero, negative and string versionIds', () => {
    for (const versionId of [1.5, 0, -3, '12', true, {}]) {
      expect(
        userCheckpointSetInput.safeParse({ versionId }).success,
        `versionId=${JSON.stringify(versionId)} must be rejected`
      ).toBe(false);
    }
  });
});
