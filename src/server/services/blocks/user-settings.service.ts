import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { sessionClient } from '~/server/auth/session-client';
import { manifestSettingsSchema } from '~/server/schema/blocks/manifest-settings.meta.schema';
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { authorizeBlockBridgeToken } from '~/server/services/blocks/block-bridge-auth.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import {
  getRepresentativeBaseModel,
  validateBlockCheckpoint,
} from '~/server/services/blocks/checkpoint.service';
import { validateBlockSettings } from '~/server/services/blocks/settings-validator.service';
import type { SessionUser } from '~/types/session';

/**
 * VIEWER SETTINGS: ONE BODY, TWO TRANSPORTS.
 *
 * This module is the single implementation of the per-viewer block-settings write —
 * the thing that persists a viewer's checkpoint override into `block_user_settings`.
 * It is called by BOTH transports and by nothing else:
 *
 *   - the bridge: `trpc.blocks.updateUserSettings`, which `IframeHost` drives from the
 *     `SET_USER_CHECKPOINT` → `USER_CHECKPOINT_SET` message pair;
 *   - REST: `POST /api/v1/blocks/user-checkpoint/set`, for an app holding a block JWT
 *     that is not running inside the host iframe.
 *
 * It was EXTRACTED from `blocks.updateUserSettings` rather than re-spelled, and that is
 * the whole point: the two transports must not be able to disagree about the same
 * viewer's setting. The precedent is `app-storage.service.ts` (#5085) and the
 * `#5054`/`#5055` "extract to a service, never add a tRPC caller" decision.
 *
 * 🔴 THE KEYING IS THE INVARIANT, AND IT IS MODEL-BOUND. `block_user_settings` is keyed
 * `@@id([block_instance_id, user_id])`, and BOTH halves of that key come from the VERIFIED
 * TOKEN, never from the request body:
 *
 *   - `blockInstanceId` ← `claims.blockInstanceId`. A caller cannot name another install,
 *     so an override cannot be written into, or read out of, an install the token does not
 *     already authorise. There is deliberately no `blockInstanceId` parameter on either
 *     transport's input.
 *   - `userId` ← `parseSubjectUserId(claims.sub)`. An anonymous subject has no user row to
 *     key on and is refused (see below).
 *
 * And the install itself is re-resolved through `BlockRegistry.resolveBlockInstance` against
 * the `(modelId, slotId, viewer)` tuple carried in the token ctx — which is what makes this
 * MODEL-BOUND rather than merely instance-bound, and what makes a synthetic id (`pdb_*`,
 * `bus_*`) fail closed instead of resolving to a row it does not own. `resolveBlockCheckpoint`
 * reads the row back on exactly the same composite key, so the write and the read agree by
 * construction.
 *
 * 🔴 A PAGE TOKEN CANNOT REACH THIS, BY DESIGN AND BY TEST. `ctx.modelId` is HARD-REQUIRED:
 * a page token (`entityType:'none'`) carries none, so it is refused with
 * `block token lacks modelId context`. That refusal is the server half of the contract
 * `PageBlockHostSetUserCheckpoint.browser.test.tsx` pins on the client half (gotcha-#73): the
 * page host NACKs `USER_CHECKPOINT_SET { ok:false }` in-host precisely BECAUSE this body
 * would refuse it anyway. Relaxing the modelId requirement here would silently un-pin that
 * test's premise.
 */

/**
 * The settings key the checkpoint override is stored under, inside the
 * `block_user_settings.settings` JSON blob.
 *
 * The hazard it guards: a writer that spelled this key any other way would persist a row
 * that resolves as "no override" FOREVER — a silent no-op, not an error. The publisher's
 * parallel key is the DIFFERENT `default_checkpoint_version_id`, so the two are one
 * plausible typo apart.
 *
 * 🔴 THIS IS **NOT** THE ONLY SPELLING OF THE KEY, AND SAYING OTHERWISE WOULD BE WORSE THAN
 * SAYING NOTHING. An earlier version of this docblock claimed "NAMED ONCE, HERE"; that was
 * false when written, and a comment that reads as consolidation is what stops the next
 * person checking. The key is open-coded in production at three sites, none of which
 * imports this constant:
 *
 *   - `IframeHost.tsx` — the BRIDGE writer, `settings: { checkpoint_version_id: versionId }`.
 *     A client component: importing this module would drag the server graph into the browser
 *     bundle, so the hand-spelling stays.
 *   - `checkpoint.service.ts` — `resolveBlockCheckpoint`, the reader at submit time.
 *   - `block-registry.service.ts` — a SECOND reader, near-duplicating the one above.
 *
 * Consolidating them is a real cleanup and is NOT done here (the client-component import is
 * the blocker for one of the three, and the duplicated resolver is its own question). What
 * IS done: `user-settings.keying.test.ts` asserts all three spellings against this constant,
 * so a rename that misses one fails a test rather than silently voiding every stored
 * override. Read that guard before changing this value.
 */
export const VIEWER_CHECKPOINT_SETTINGS_KEY = 'checkpoint_version_id';

/**
 * REST input for `POST /api/v1/blocks/user-checkpoint/set`.
 *
 * `versionId: null` CLEARS the override — that is the SDK's documented `persist(null)`, and
 * it must stay expressible, so the field is nullable rather than optional. `.optional()`
 * would make "clear it" and "I forgot to send it" the same request.
 *
 * Deliberately NOT the router's generic 4KB-capped `settingsSchema`: this route accepts one
 * bounded scalar, so there is no blob to cap. The generic schema stays on the bridge input,
 * which really does accept an arbitrary record.
 */
export const userCheckpointSetInput = z.object({
  versionId: z.number().int().positive().nullable(),
});

export type UpdateBlockUserSettingsResult = { ok: true };

/**
 * 🔴 WHY THE TOKEN IS AUTHORIZED BY THE CALLER AND CLAIMS ARE PASSED IN, RATHER THAN THIS
 * BODY TAKING THE RAW TOKEN THE WAY `app-storage.service` DOES.
 *
 * `no-unguarded-block-bridge-token.test.ts` computes guard reachability TEXTUALLY, inside
 * `blocks.router.ts` ONLY. Its own docblock states the consequence: "a proc that delegates
 * to an imported helper which calls `authorizeBlockBridgeToken` reads as UNGUARDED and
 * fails". So if this body owned the `authorizeBlockBridgeToken` call, rewiring
 * `blocks.updateUserSettings` to delegate here would have turned that guard RED — and the
 * cheap way out (adding the proc to an exemption list) would have blinded a real guard on
 * every OTHER bridge proc's behalf.
 *
 * Splitting at the claims boundary satisfies both constraints honestly: the router keeps a
 * literal `authorizeBlockBridgeToken(input.blockToken)` in its own text, the REST route
 * reaches the identical call through `updateBlockUserSettings` below, and the token is
 * authorized EXACTLY ONCE per request on either path — no double revocation read. Everything
 * that the two transports must agree about is below this line, in one copy.
 */
export async function updateBlockUserSettings(opts: {
  blockToken: string;
  settings: Record<string, unknown>;
}): Promise<UpdateBlockUserSettingsResult> {
  const claims = await authorizeBlockBridgeToken(opts.blockToken);
  return updateBlockUserSettingsFromClaims({ claims, settings: opts.settings });
}

/**
 * Persist a viewer's per-block-instance settings. THE shared body — see the module docblock.
 *
 * Gated, in order, on:
 *   1. a valid block JWT (`authorizeBlockBridgeToken`, which also covers revocation and the
 *      backing app's `approved` status) — run by the CALLER, see the note above;
 *   2. a NON-ANONYMOUS subject — anon is refused `UNAUTHORIZED`, because the write's own
 *      primary key needs a `user_id` and there is no row to key on;
 *      3. the `app-blocks-enabled` audience, evaluated against the TOKEN SUBJECT
 *      (`assertAppBlocksEnabledForTokenUser`) — NOT `enforceAppBlocksFlag`.
 *
 *      ⚠ THE REASON, STATED PRECISELY, BECAUSE THE SHORT VERSION IS CONTESTED. The short
 *      version — "`ctx.user` is undefined on a block-token transport" — is what #5085's
 *      body said, and #5087 explicitly records it as REFUTED: `blockFliptUser`
 *      (`block-workflow-rest.ts:154`) hydrates exactly such a user from a verified block
 *      token on a REST transport, so "a REST transport cannot have a ctx.user" is simply
 *      not true as a general claim. Do not repeat it.
 *
 *      What IS true here, and is the actual reason: `enforceAppBlocksFlag` is a tRPC
 *      MIDDLEWARE, and neither caller is in a position to use it — the REST route mints no
 *      tRPC caller at all, so there is no ctx to hydrate, and the bridge proc is a
 *      `publicProcedure` whose ctx carries no session (dev:live has none). The gate must
 *      therefore bind to the token subject on both paths, which is what
 *      `assertAppBlocksEnabledForTokenUser` does. That is also the conclusion #5087
 *      reaches for the five storage procedures — the outcome is agreed; only the
 *      justification above was wrong;
 *   4. `assertViewerIsAppDeveloper`, the app-AUTHORING capability — see the note below,
 *      which is the one semantic here a reader will not expect;
 *   5. a token ctx carrying an integer `modelId` and a non-empty `slotId`;
 *   6. the `(modelId, slotId, viewer)` tuple resolving to a real install.
 *
 * Then the payload is filtered against the app block's own manifest (`forScope: 'viewer'`,
 * so publisher-scoped keys a viewer payload happens to carry are DROPPED rather than
 * failing the call), the checkpoint is re-validated for ecosystem match at write time, and
 * the row is upserted.
 *
 * Re-validating at write time is what keeps `resolveBlockCheckpoint` from ever having to
 * reject a persisted value: the caller gets a structured `cause.reason` inline instead of a
 * surprise failure at the next generate.
 *
 * 🔴 IT THROWS; IT NEVER RESOLVES A SOFT FAILURE. Both transports depend on that. The bridge
 * reply `USER_CHECKPOINT_SET { ok:false, error }` is synthesised by the HOST from a caught
 * rejection, and the SDK's `persist()` THROWS that error — so a body that returned
 * `{ ok: false }` would be read as a successful persist by every caller. Same contract as
 * `app-storage/set.ts`.
 *
 * 🔴 RATE LIMIT: NONE, DELIBERATELY — carried over verbatim from the procedure this was
 * extracted from, including its reasoning. #569 added a catalog limit whose own stated
 * justification ("a viewer changing a dropdown — single digits per session — against a
 * ceiling of 120/10 s") argued against the limit it introduced; it was removed in that
 * round-0 audit. What bounds this instead: `assertViewerIsAppDeveloper` gates every call,
 * the payload is bounded (one scalar on REST, 4KB on the bridge), the write is a single
 * upsert on an already-resolved install, and surviving fields are filtered against the
 * app block's manifest. A caller cannot make this do more work by calling it differently.
 */
export async function updateBlockUserSettingsFromClaims(opts: {
  claims: BlockTokenClaims;
  settings: Record<string, unknown>;
}): Promise<UpdateBlockUserSettingsResult> {
  const { claims } = opts;
  const userId = parseSubjectUserId(claims.sub);
  if (userId == null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'anon viewers cannot persist block settings',
    });
  }
  // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
  await assertAppBlocksEnabledForTokenUser(userId);
  await assertViewerIsAppDeveloper(userId);

  const ctxModelId = Number((claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN);
  if (!Number.isInteger(ctxModelId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks modelId context' });
  }
  const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
  if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
  }

  // Resolve the install (or synthetic source row) so we can pull the app block's manifest +
  // scopes for the validator. Re-validation of the (modelId, slotId, viewer) tuple is handled
  // inside resolveBlockInstance — synthetic ids fail-closed without it.
  const resolved = await BlockRegistry.resolveBlockInstance({
    blockInstanceId: claims.blockInstanceId,
    modelId: ctxModelId,
    slotId: ctxSlotId,
    viewerUserId: userId,
    db: 'read',
  });
  if (!resolved) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Block install not found' });
  }

  // Manifest-driven shape validation. Wrong-scope fields are silently skipped, so a viewer
  // payload that accidentally includes publisher keys just drops them rather than failing
  // the whole call.
  const parsedManifestSettings = manifestSettingsSchema.safeParse(
    (resolved.appBlock.manifest as Record<string, unknown>).settings ?? {}
  );
  const validatedSettings = parsedManifestSettings.success
    ? validateBlockSettings({
        manifestSettings: parsedManifestSettings.data,
        inputSettings: opts.settings,
        declaredScopes: resolved.appBlock.approvedScopes,
        forScope: 'viewer',
      })
    : opts.settings;

  // Cross-row validation for the resource_picker → checkpoint case (same known field name
  // pattern as the publisher path in block-registry.validateInstallSettings). Skip when
  // explicitly clearing (`null`) — that's just dropping the override.
  if (typeof validatedSettings[VIEWER_CHECKPOINT_SETTINGS_KEY] === 'number') {
    const baseModel = await getRepresentativeBaseModel(ctxModelId);
    if (!baseModel) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cannot determine base model for the bound install',
      });
    }
    await validateBlockCheckpoint({
      checkpointVersionId: validatedSettings[VIEWER_CHECKPOINT_SETTINGS_KEY] as number,
      forBaseModel: baseModel,
      reason: 'viewer-override',
    });
  }

  await BlockRegistry.upsertUserSettings({
    blockInstanceId: claims.blockInstanceId,
    userId,
    settings: validatedSettings,
  });

  // Audit — log every viewer-settings write (including checkpoint pin swaps) to the activity
  // feed. Fire-and-forget.
  //
  // This write is authorized by valid-token + app-developer + installer resolution above —
  // NOT by a token block-scope. The audit row must not assert a scope that was never checked,
  // so it labels the ACTION itself (matching `endpoint`) rather than claiming a
  // `block:settings:write` scope (that scope was decorative/unenforced and has been removed).
  void (async () => {
    const { recordScopeInvocation } = await import(
      '~/server/services/blocks/user-app-surface.service'
    );
    await recordScopeInvocation({
      userId,
      appBlockId: claims.appBlockId,
      blockInstanceId: claims.blockInstanceId,
      scope: 'user-settings:write',
      endpoint: 'user-settings:write',
      statusCode: 200,
      detail: { action: 'settings.update', outcome: 'ok' },
    });
    // Swallowed on purpose: the audit row is best-effort and must never fail the write the
    // viewer actually asked for. Spelled `=> undefined` rather than the `=> {}` this code
    // used in the router, which trips `@typescript-eslint/no-empty-function` — a
    // PRE-EXISTING lint error on main (`blocks.router.ts:7226`) that would otherwise have
    // travelled here verbatim with the extraction.
  })().catch(() => undefined);

  return { ok: true };
}

/**
 * Set (or CLEAR, with `versionId: null`) the viewer's per-install checkpoint override.
 *
 * A thin adapter over `updateBlockUserSettings` — every gate, the manifest filter, the
 * ecosystem re-validation and the model-bound keying run verbatim, in one place, and none of
 * them is re-spelled here. The ONLY thing this adds is the settings-key spelling, which is
 * `VIEWER_CHECKPOINT_SETTINGS_KEY` and is therefore also not re-spelled.
 *
 * Note the manifest filter still applies: an app whose manifest does not declare a
 * viewer-scoped `checkpoint_version_id` setting will have the field DROPPED, and the upsert
 * writes `{}`. That is the pre-existing behaviour of the bridge path, preserved deliberately
 * — it is the mechanism by which an app cannot persist settings it never declared.
 */
export async function setUserCheckpointOverride(
  blockToken: string,
  versionId: number | null
): Promise<UpdateBlockUserSettingsResult> {
  return updateBlockUserSettings({
    blockToken,
    settings: { [VIEWER_CHECKPOINT_SETTINGS_KEY]: versionId },
  });
}

/**
 * The app-AUTHORING capability, asserted against a BLOCK-TOKEN-resolved subject.
 *
 * 🔴 THIS IS A DELIBERATE EXCEPTION, CARRIED OVER UNCHANGED — do not "unify" it, and do not
 * drop it from one transport. `blocks.router.ts` documents it at length: the authoring gate
 * was removed from the RUNTIME procedures (generate, estimate, poll, cancel, balance) because
 * it blocked the whole non-author cohort from USING an app, and exactly one call site was
 * kept — this write — on the reasoning that persisting an install's settings is an
 * authoring-shaped action that no block scope expresses.
 *
 * 🔴 AND IT IS THE REASON THE REST TWIN ALONE DOES NOT FINISH THE CONSUMER'S STORY. A viewer
 * who is not an app author cannot persist a checkpoint override over EITHER transport — the
 * gate is shared, so REST inherits it exactly. Whether a PER-VIEWER setting belongs behind an
 * AUTHORING capability is a real open question (the row is keyed per viewer and the payload
 * is validated `forScope: 'viewer'`), but it is a POLICY change affecting the bridge as much
 * as REST, and answering it here — in a transport PR — would have silently diverged the two.
 * Filed separately; see the PR body.
 *
 * Hydrates the subject via `sessionClient.getSessionUserById`, the authoritative hub-backed
 * resolver, identically to `assertAppBlocksEnabledForTokenUser` which runs right before it —
 * never a client-supplied value — so `buildFliptContext` sees the subject's real
 * isModerator/tier and the mod floor / segment match cannot be spoofed.
 *
 * 🔴 A VANISHED SUBJECT IS REFUSED BEFORE THE CAPABILITY IS EVALUATED. A no-user eval cannot
 * match a segment, but its answer is the flag's own base `enabled` value — so a base-
 * `enabled: true` widening of `app-blocks-author` would turn an unresolvable subject into a
 * PASS on an AUTHZ gate. The refusal is structural: no subject, no capability, no Flipt call.
 * It is not optional politeness either: `user` is a REQUIRED, non-nullable parameter of
 * `isAppBlocksAuthorEnabled`, so this narrowing is what makes the next line compile, and
 * deleting it is a type error rather than a silent re-opening.
 *
 * 🔴 UNLIKE ITS SIBLING `assertAppBlocksEnabledForTokenUser`, THIS REFUSAL IS NOT ON THE
 * COMPILED-BRANCH WATCHLIST, and that is measured rather than assumed: losing it cannot
 * silently re-open anything, because `isAppBlocksAuthorEnabled` takes a non-nullable subject
 * and dereferences it immediately, so a dropped guard yields a `TypeError` (a 500) rather
 * than a pass. The enabled gate's guard IS watchlisted, because losing THAT one falls
 * through to a global eval returning the flag's base value.
 *
 * The two messages differ on purpose — two different conditions, and an identical string
 * under a different code is not separable in a log. Both are also distinct APP-WIDE, which
 * is the level that matters to an operator. If you add another refusal of this shape, give
 * it text no other one uses.
 *
 * This is the AUTHZ half only; the `isAppBlocksEnabled` kill-switch
 * (`assertAppBlocksEnabledForTokenUser`) still runs first and is unchanged — it is the
 * kill-switch and it stays on EVERY block-token proc.
 */
async function assertViewerIsAppDeveloper(userId: number): Promise<void> {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  if (!user) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'app-authoring subject could not be resolved',
    });
  }
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Apps authoring is not enabled for this account',
    });
  }
}
