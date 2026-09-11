export type ReciprocalSkipReason = 'notOwned' | 'alreadyLinked' | 'atLimit';

/**
 * THE definition of "added during this edit", and the only one. The server decides what to
 * write with it and the checkbox describes what will happen with it; if you are about to write
 * a second predicate that answers this question, that is the bug this module exists to prevent.
 * Three defects on the retired branch came from client and server each holding their own copy.
 *
 * It asks which MODEL ids are new, never which association rows are, because an association id
 * is a claim the client makes and a model id is a fact both sides can check. `alreadyLinked` is
 * the set of model ids the edited model already points at: read from the writer on the server,
 * from the fetched association list on the client.
 */
export function selectNewlyAddedModelIds(
  selection: ReadonlyArray<{ resourceType: 'model' | 'article'; resourceId: number }>,
  alreadyLinked: ReadonlySet<number>
): number[] {
  return selection
    .filter((item) => item.resourceType === 'model' && !alreadyLinked.has(item.resourceId))
    .map((item) => item.resourceId);
}

export type ReciprocalCandidate = { modelId: number; ownerId: number };

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
