import {
  type ModelVersionTerms,
  grantsGeneration,
  isFreeGeneration,
  isPaidAccessActive,
} from '@civitai/buzz';
import { EntityAccessPermission } from '~/server/common/enums';
import { hasEntityAccess } from '~/server/services/common.service';
import { getViewerMonetization } from '~/server/services/paid-access.service';

// The subset of a generation resource that paid-access gating reads/mutates. Kept structural so the
// caller passes its full (much larger) resource type unchanged.
export type PaidAccessGatingResource = {
  id: number;
  /** Decides whether the gate prices on the image or video ceiling. */
  baseModel?: string | null;
  covered?: boolean | null;
  hasAccess: boolean;
  canGenerate: boolean;
  paidAccess: { endsAt: Date | null; terms: ModelVersionTerms } | null;
};
type GenerationViewer = { id?: number; isModerator?: boolean };

// The ids the viewer has PURCHASED generation access to (the EntityAccess side of the decision, which
// the terms can't know). One batched lookup; empty for anon.
async function getPurchasedGenerationIds(
  ids: number[],
  user: GenerationViewer
): Promise<Set<number>> {
  if (!user.id || !ids.length) return new Set();
  const access = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: ids,
    userId: user.id,
    isModerator: user.isModerator,
    permissions: EntityAccessPermission.EarlyAccessGeneration,
  });
  return new Set(access.filter((e) => e.hasAccess).map((e) => e.entityId));
}

/**
 * Resolve generation access for gated resources. Gating lives in PaidAccess now, but a gated version's
 * `availability` stays 'Public', so resource-data optimistically set hasAccess=true — this replaces it
 * with the real decision (owner/mod, purchased, or open to non-buyers). This is the SOLE enforcement
 * point for the paid generation gate (skipping it is how the paywall bypass shipped). Terms come from
 * the PaidAccess cache (not the 1h resourceDataCache, which would go stale).
 */
export async function applyPaidAccessGating<T extends PaidAccessGatingResource>(
  resources: T[],
  user: GenerationViewer
) {
  // Deduped by id, keeping each version's baseModel: a video gate priced above the image ceiling would
  // otherwise advertise a lower price here than earlyAccessPurchase actually charges.
  const byId = new Map(resources.map((r) => [r.id, { id: r.id, baseModel: r.baseModel }]));
  if (!byId.size) return;
  // Wire prices are what this viewer is charged, so a lapsed owner can't advertise more than they bill.
  // The decision below is unaffected: it turns on free/trial/purchase, never on a price.
  const monetization = await getViewerMonetization({
    versions: [...byId.values()],
    viewer: user,
  });
  const isOwnerOrMod = (ownerId: number) =>
    (!!user.id && ownerId === user.id) || !!user.isModerator;

  const gated = new Map<number, { resource: T; ownerId: number; terms: ModelVersionTerms }>();
  for (const r of resources) {
    const row = monetization[r.id]?.paidAccess;
    if (row && isPaidAccessActive(row)) {
      gated.set(r.id, { resource: r, ownerId: row.ownerId, terms: row.terms as ModelVersionTerms });
      r.paidAccess = { endsAt: row.endsAt, terms: row.terms as ModelVersionTerms };
    } else {
      r.paidAccess = null;
    }
  }

  // One purchase lookup, only for gated resources a non-owner must pay for (covered + non-free).
  const purchased = await getPurchasedGenerationIds(
    [...gated.values()]
      .filter(
        ({ resource, ownerId, terms }) =>
          resource.covered && !isOwnerOrMod(ownerId) && !isFreeGeneration(terms)
      )
      .map(({ resource }) => resource.id),
    user
  );

  for (const { resource, ownerId, terms } of gated.values()) {
    resource.hasAccess = grantsGeneration(terms, {
      isOwnerOrMod: isOwnerOrMod(ownerId),
      hasBought: purchased.has(resource.id),
    });
    resource.canGenerate = resource.hasAccess && resource.canGenerate;
  }
}
