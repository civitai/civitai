import { type ModelVersionTerms, grantsGeneration, isFreeGeneration, isPaidAccessActive } from '@civitai/buzz';
import { EntityAccessPermission } from '~/server/common/enums';
import { hasEntityAccess } from '~/server/services/common.service';
import { getPaidAccess } from '~/server/services/paid-access.service';

// The subset of a generation resource that paid-access gating reads/mutates. Kept structural so the
// caller passes its full (much larger) resource type unchanged.
export type PaidAccessGatingResource = {
  id: number;
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
  const ids = [...new Set(resources.map((r) => r.id))];
  if (!ids.length) return;
  const paidAccess = await getPaidAccess('ModelVersion', ids);
  const isOwnerOrMod = (ownerId: number) => (!!user.id && ownerId === user.id) || !!user.isModerator;

  // Collect the active gates + expose their terms on the wire DTO; ungated resources are untouched.
  const gated = new Map<number, { resource: T; ownerId: number; terms: ModelVersionTerms }>();
  for (const r of resources) {
    const row = paidAccess[r.id];
    if (row && isPaidAccessActive(row)) {
      const terms = row.terms as ModelVersionTerms;
      gated.set(r.id, { resource: r, ownerId: row.ownerId, terms });
      r.paidAccess = { endsAt: row.endsAt, terms };
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
