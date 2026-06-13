import { BlockRegistry } from '~/server/services/block-registry.service';
import { logToAxiom } from '~/server/logging/client';
import {
  type BlockAttributionScope,
  ATTRIBUTION_METADATA_KEYS,
} from '~/server/schema/blocks/attribution.schema';
import type { ResolvedBlockSource } from '~/server/services/block-registry.service';

/**
 * FIN-1 hardening: re-validate / re-derive every App Blocks revenue-
 * attribution field SERVER-SIDE before it is stamped onto a payment
 * provider's metadata.
 *
 * Background — the attack this closes:
 *   The browser (BuzzPurchaseImproved.tsx) stamps blockAppId /
 *   blockAppBlockId / blockInstanceId / blockScope / blockModelId into the
 *   Stripe PaymentIntent metadata from a client `attribution` object, and
 *   `getPaymentIntent` previously copied that metadata verbatim into Stripe.
 *   The webhook later reads those fields back and credits a publisher's
 *   revenue share. Because NOTHING re-checked that the buyer actually
 *   viewed/owns the cited install, that the cited scope matched the
 *   install, or that the cited app matched, any authenticated user could
 *   mint fake publisher earnings against a purchase that never touched a
 *   block (e.g. a 2-account ring asserting a confederate's app with the
 *   25% `viewer_personal` scope).
 *
 * This module is the single server-side chokepoint that closes all four
 * forge vectors. It runs inside `getPaymentIntent`, which still has the
 * authenticated tRPC session (`ctx.user` → `user.id`). Anything the client
 * asserted about the block attribution is discarded and re-derived from the
 * resolved install row, OR — when the buyer is not a legitimate
 * viewer/owner of the cited instance — STRIPPED so the purchase proceeds as
 * a normal, non-attributed buzz purchase. We never hard-reject a real-money
 * purchase over a bad attribution.
 *
 * The webhook also re-asserts the spender invariant defensively (see
 * recordAttribution), but the primary gate is here because this is the only
 * place that holds the authenticated session.
 */

const LOG_NAME = 'block-attribution-validate';

/**
 * Map the resolver's `source` discriminant onto the attribution-scope
 * vocabulary used by the rate card / metadata. The resolver is the source
 * of truth for which install surface actually applies, so the scope is
 * derived from it rather than from the client-supplied `blockScope`.
 */
const SOURCE_TO_SCOPE: Record<ResolvedBlockSource, BlockAttributionScope> = {
  // Post 2026-05-30 kill_per_model_installs: the resolver's `install` source
  // is a per-model-PINNED block_user_subscriptions row (the old
  // model_block_installs table is gone), so it shares the publisher earnings
  // bucket with the blanket `publisher_subscription` shape rather than the
  // stale `per_model_install` bucket. The V2 rate card pays both at the same
  // publisher percentage, so this aligns reporting/buckets without changing
  // any payout amount. (L-M2, kept in lockstep with deriveScopeFromInstanceId.)
  install: 'publisher_all_my_models',
  publisher_subscription: 'publisher_all_my_models',
  viewer_subscription: 'viewer_personal',
  platform_default: 'platform_default',
};

/**
 * Loose shape for the block-attribution-relevant metadata keys. Mirrors the
 * stripe buzz-purchase metadata; everything is optional and string-ish on
 * the wire (Stripe stringifies metadata).
 */
export type BlockAttributionMetadataInput = {
  [ATTRIBUTION_METADATA_KEYS.appId]?: string | null;
  [ATTRIBUTION_METADATA_KEYS.appBlockId]?: string | null;
  [ATTRIBUTION_METADATA_KEYS.blockInstanceId]?: string | null;
  [ATTRIBUTION_METADATA_KEYS.scope]?: string | null;
  [ATTRIBUTION_METADATA_KEYS.modelId]?: string | number | null;
  [ATTRIBUTION_METADATA_KEYS.slotId]?: string | null;
};

const BLOCK_KEYS = [
  ATTRIBUTION_METADATA_KEYS.appId,
  ATTRIBUTION_METADATA_KEYS.appBlockId,
  ATTRIBUTION_METADATA_KEYS.blockInstanceId,
  ATTRIBUTION_METADATA_KEYS.scope,
  ATTRIBUTION_METADATA_KEYS.modelId,
  ATTRIBUTION_METADATA_KEYS.slotId,
] as const;

/** Return a copy of `metadata` with every block-attribution key removed. */
function stripBlockKeys<T extends Record<string, unknown>>(metadata: T): T {
  const out = { ...metadata };
  for (const k of BLOCK_KEYS) {
    delete (out as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * Validate & re-derive the block-attribution fields on a buzz-purchase
 * metadata bag against the authenticated session user.
 *
 * @param metadata        The (already amount-validated) buzz-purchase
 *                        metadata about to be sent to the payment provider.
 * @param sessionUserId   `ctx.user.id` — the authenticated buyer. This is
 *                        the ONLY trusted spender identity.
 * @returns A new metadata object. When block-attribution fields were
 *          present and valid, they are overwritten with server-derived
 *          values. When they were present but invalid (forged), they are
 *          stripped so the purchase proceeds un-attributed. When absent,
 *          the metadata is returned unchanged (modulo the userId re-assert,
 *          which non-block purchases also benefit from).
 *
 * @throws  When the client asserted a `metadata.userId` that disagrees with
 *          the session user — that's a spender spoof and we refuse to let a
 *          client charge/credit as someone else. (Block fields aside, the
 *          buzz itself must be credited to the session user.)
 */
export async function validateBuzzPurchaseAttribution<
  T extends Record<string, unknown> & { userId?: unknown }
>(opts: { metadata: T; sessionUserId: number }): Promise<T> {
  const { metadata, sessionUserId } = opts;

  // -----------------------------------------------------------------
  // Vector 1 — spender spoof. The buzz recipient is whatever
  // metadata.userId says downstream (webhook + getPaymentIntentsForBuzz
  // both read it). A client asserting a userId != session user is trying
  // to credit buzz / attribution as someone else. Force it to the session
  // id; reject when it disagrees so the mismatch surfaces loudly rather
  // than silently re-pointing a charge.
  // -----------------------------------------------------------------
  const assertedUserId = metadata.userId;
  if (assertedUserId != null && assertedUserId !== '') {
    const asNum = Number(assertedUserId);
    if (!Number.isFinite(asNum) || asNum !== sessionUserId) {
      logToAxiom(
        {
          name: LOG_NAME,
          type: 'warning',
          message: 'rejected buzz purchase: metadata.userId != session user',
          assertedUserId: String(assertedUserId),
          sessionUserId,
        },
        'webhooks'
      ).catch(() => null);
      throw new Error('There was an error while creating your order. Please try again later.');
    }
  }

  // Always pin the spender to the session user (covers the absent-userId
  // case too — non-block purchases benefit from this as well).
  const base = { ...metadata, userId: sessionUserId } as T;

  // -----------------------------------------------------------------
  // No block-attribution fields present → non-block purchase. Unchanged
  // passthrough (other than the userId pin above).
  // -----------------------------------------------------------------
  const appId = base[ATTRIBUTION_METADATA_KEYS.appId];
  const blockInstanceId = base[ATTRIBUTION_METADATA_KEYS.blockInstanceId];
  if (appId == null || appId === '') {
    return base;
  }

  // A blockAppId without a blockInstanceId can't be resolved → strip.
  if (blockInstanceId == null || blockInstanceId === '') {
    logToAxiom(
      {
        name: LOG_NAME,
        type: 'warning',
        message: 'stripped attribution: blockAppId present without blockInstanceId',
        sessionUserId,
      },
      'webhooks'
    ).catch(() => null);
    return stripBlockKeys(base);
  }

  // -----------------------------------------------------------------
  // Vectors 2/3/4 — install existence, scope, and app. Resolve the cited
  // instance AS THE SESSION USER. The resolver re-applies the same
  // predicates listForModel uses for each rank (viewer match for viewer
  // subs, model-owner match for publisher subs, target_model_types for
  // platform defaults, etc). A null result means the buyer is NOT a
  // legitimate viewer/owner of this instance → strip, don't reject.
  //
  // modelId is the client-supplied analytics hint; the resolver needs a
  // model + slot to validate against. We can't trust the client modelId
  // blindly, but the resolver re-validates ownership/visibility against
  // whatever modelId we pass — a forged modelId simply fails to resolve
  // and the attribution is stripped (fail-safe). slotId is likewise
  // client-influenced; the resolver requires the source row to actually
  // surface on that (model, slot), so a wrong slot fails to resolve.
  // -----------------------------------------------------------------
  const clientModelId = base[ATTRIBUTION_METADATA_KEYS.modelId];
  const modelIdNum =
    clientModelId != null && clientModelId !== '' ? Number(clientModelId) : NaN;
  const clientSlotId = base[ATTRIBUTION_METADATA_KEYS.slotId];
  const slotId = typeof clientSlotId === 'string' && clientSlotId ? clientSlotId : undefined;

  // Without a usable modelId + slotId we cannot re-validate the instance →
  // strip (fail-safe). Synthetic-instance scopes (publisher/viewer/platform)
  // all require a (model, slot) to surface; per_model installs carry their
  // own but resolveBlockInstance still requires modelId + slotId in its
  // signature.
  if (!Number.isFinite(modelIdNum) || modelIdNum <= 0 || !slotId) {
    logToAxiom(
      {
        name: LOG_NAME,
        type: 'warning',
        message: 'stripped attribution: missing modelId/slotId for server re-validation',
        sessionUserId,
        blockInstanceId: String(blockInstanceId),
        hasModelId: Number.isFinite(modelIdNum),
        hasSlotId: Boolean(slotId),
      },
      'webhooks'
    ).catch(() => null);
    return stripBlockKeys(base);
  }

  let resolved;
  try {
    resolved = await BlockRegistry.resolveBlockInstance({
      blockInstanceId: String(blockInstanceId),
      modelId: modelIdNum,
      slotId,
      viewerUserId: sessionUserId,
      db: 'write',
    });
  } catch (err) {
    // A resolver failure must not break the purchase. Strip + log.
    logToAxiom(
      {
        name: LOG_NAME,
        type: 'error',
        message: 'stripped attribution: resolveBlockInstance threw',
        sessionUserId,
        blockInstanceId: String(blockInstanceId),
        error: (err as Error)?.message,
      },
      'webhooks'
    ).catch(() => null);
    return stripBlockKeys(base);
  }

  if (!resolved) {
    // Forged / non-surfacing instance for this buyer → strip.
    logToAxiom(
      {
        name: LOG_NAME,
        type: 'warning',
        message: 'stripped attribution: instance did not resolve for buyer',
        sessionUserId,
        blockInstanceId: String(blockInstanceId),
        clientAppId: String(appId),
        clientScope: String(base[ATTRIBUTION_METADATA_KEYS.scope] ?? ''),
        clientModelId: modelIdNum,
        slotId,
      },
      'webhooks'
    ).catch(() => null);
    return stripBlockKeys(base);
  }

  // -----------------------------------------------------------------
  // Resolved. Re-derive EVERY block field from the resolved row — never
  // trust the client values.
  //   - scope: derived from resolved.source (vector 3).
  //   - appId / appBlockId: from resolved.appBlock (vector 4).
  //   - modelId: the server-validated resolved.modelId (vector 2 — the
  //     resolver already confirmed this is the model the instance surfaces
  //     on for this buyer).
  // -----------------------------------------------------------------
  const derivedScope = SOURCE_TO_SCOPE[resolved.source];
  // Build the server-derived block fields in a plain string map, then merge
  // onto the stripped base. (Writing through a generic-indexed type is not
  // allowed by TS — merge avoids that without an unsafe per-key cast.)
  const derivedFields: Record<string, string> = {
    [ATTRIBUTION_METADATA_KEYS.appId]: resolved.appBlock.appId,
    [ATTRIBUTION_METADATA_KEYS.appBlockId]: resolved.appBlock.id,
    [ATTRIBUTION_METADATA_KEYS.blockInstanceId]: String(blockInstanceId),
    [ATTRIBUTION_METADATA_KEYS.scope]: derivedScope,
    [ATTRIBUTION_METADATA_KEYS.modelId]: String(resolved.modelId),
  };
  const out = { ...stripBlockKeys(base), ...derivedFields } as T;

  if (
    String(appId) !== resolved.appBlock.appId ||
    String(base[ATTRIBUTION_METADATA_KEYS.scope] ?? '') !== derivedScope
  ) {
    logToAxiom(
      {
        name: LOG_NAME,
        type: 'info',
        message: 'corrected forged/mismatched attribution fields',
        sessionUserId,
        blockInstanceId: String(blockInstanceId),
        clientAppId: String(appId),
        derivedAppId: resolved.appBlock.appId,
        clientScope: String(base[ATTRIBUTION_METADATA_KEYS.scope] ?? ''),
        derivedScope,
        source: resolved.source,
      },
      'webhooks'
    ).catch(() => null);
  }

  return out as T;
}
