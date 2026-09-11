export type ReciprocalSkipReason = 'notOwned' | 'alreadyLinked' | 'atLimit';

export type ReciprocalCandidate = { modelId: number; ownerId: number | null };

export type ReciprocalPlan = {
  create: Array<{ fromModelId: number; toModelId: number; index: number }>;
  skipped: Array<{ modelId: number; reason: ReciprocalSkipReason }>;
};

/**
 * Decides which back-links a "link both ways" save may write.
 *
 * `ownerId` is the owner of the model being edited, not the acting user — a moderator
 * editing someone else's model still links that owner's models together, never their own.
 */
export function planReciprocalAssociations({
  sourceModelId,
  ownerId,
  candidates,
  existingCounts,
  alreadyLinked,
  limit,
}: {
  sourceModelId: number;
  ownerId: number;
  candidates: ReciprocalCandidate[];
  existingCounts: Map<number, number>;
  alreadyLinked: Set<number>;
  limit: number;
}): ReciprocalPlan {
  const plan: ReciprocalPlan = { create: [], skipped: [] };
  const seen = new Set<number>();

  for (const { modelId, ownerId: candidateOwnerId } of candidates) {
    if (modelId === sourceModelId || seen.has(modelId)) continue;
    seen.add(modelId);

    if (candidateOwnerId !== ownerId) {
      plan.skipped.push({ modelId, reason: 'notOwned' });
      continue;
    }
    if (alreadyLinked.has(modelId)) {
      plan.skipped.push({ modelId, reason: 'alreadyLinked' });
      continue;
    }

    const count = existingCounts.get(modelId) ?? 0;
    if (count >= limit) {
      plan.skipped.push({ modelId, reason: 'atLimit' });
      continue;
    }

    plan.create.push({ fromModelId: modelId, toModelId: sourceModelId, index: count });
  }

  return plan;
}
