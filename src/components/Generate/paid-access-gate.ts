import type { ModelVersionTerms } from '@civitai/buzz';
import { generationPrice, isFreeGeneration, requiresGenerationPurchase } from '@civitai/buzz';
import { EntityAccessPermission } from '~/server/common/enums';

/** One selected resource the viewer can still be sold generation access to. */
export type PurchaseGate = {
  modelVersionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  price?: number;
};

type GateResource = {
  id: number;
  name: string;
  paidAccess?: { endsAt: Date | null; terms: ModelVersionTerms } | null;
  isOwnedByUser?: boolean;
  model: { id: number; name: string };
};

type AccessRow = { entityId: number; hasAccess: boolean; permissions: number };

export type SelectedResources = {
  model?: { id: number } | null;
  resources?: { id: number }[] | null;
  vae?: { id: number } | null;
};

export function selectedResourceIds({ model, resources, vae }: SelectedResources): number[] {
  return [model?.id, ...(resources ?? []).map((resource) => resource.id), vae?.id].filter(
    (id): id is number => id != null
  );
}

/**
 * The resources worth an access lookup. Owners and moderators are dropped BEFORE the query, not after:
 * `hasEntityAccess` grants an owner only when every id in the batch is theirs, so one stranger's gated
 * resource in the same batch would report a creator as a non-buyer of their own model.
 */
export function purchaseGateCandidates<T extends GateResource>(
  resources: T[],
  { isModerator }: { isModerator?: boolean }
): T[] {
  if (isModerator) return [];
  return resources.filter((resource) => {
    const terms = resource.paidAccess?.terms;
    // `paidAccess` is populated only for live gates upstream, so its presence is the active-gate test.
    if (!terms || resource.isOwnedByUser) return false;
    return !isFreeGeneration(terms) && generationPrice(terms) != null;
  });
}

const boughtGeneration = (rows: AccessRow[] | undefined) =>
  new Set(
    (rows ?? [])
      .filter(
        (row) =>
          row.hasAccess && (row.permissions & EntityAccessPermission.EarlyAccessGeneration) !== 0
      )
      .map((row) => row.entityId)
  );

export function resolvePurchaseGates<T extends GateResource>(
  resources: T[],
  access: AccessRow[] | undefined,
  { isModerator }: { isModerator?: boolean }
): PurchaseGate[] {
  const bought = boughtGeneration(access);
  return purchaseGateCandidates(resources, { isModerator })
    .filter((resource) =>
      requiresGenerationPurchase(resource.paidAccess!.terms, {
        isOwnerOrMod: false,
        hasBought: bought.has(resource.id),
      })
    )
    .map((resource) => ({
      modelVersionId: resource.id,
      modelId: resource.model.id,
      modelName: resource.model.name,
      versionName: resource.name,
      price: generationPrice(resource.paidAccess!.terms),
    }));
}

/**
 * The orchestrator reports trial state as prose — "You have 1 trial generations remaining with
 * <model> - <version>" — and the SAME sentence means different things per channel: as a whatIf error it
 * REJECTS the estimate (asking for 4 images against 1 remaining trial), as a submit error it refuses the
 * job, as a step warning it is advisory. So the count decides the copy and the channel decides whether
 * the user is blocked; neither alone is enough. There is no code to key on — the pinned client's
 * `WorkflowStepWarningCode` declares only `modelDeprecated` — so this match is the only trigger there is.
 * It lives here, with a test, so upstream rewording is one edit rather than a hunt through the footer.
 */
const TRIAL_MESSAGE = /(\d+)?\s*\btrial generations?\b[\s\S]{0,40}?\bremaining\b/i;

/** `{ remaining }` when the message is about generation trials, undefined when it is about anything else. */
export function parseTrialMessage(
  message?: string | null
): { remaining: number | undefined } | undefined {
  if (!message) return undefined;
  const match = TRIAL_MESSAGE.exec(message);
  if (!match) return undefined;
  const remaining = match[1] != null ? Number(match[1]) : undefined;
  return { remaining: Number.isFinite(remaining) ? remaining : undefined };
}

/**
 * Exhausted, not merely mentioned. A count still above zero is the ADVANCE warning and must not claim
 * the trial is spent; a trial message carrying no count is treated as exhausted because the only thing
 * that produces one at submit time is a refusal.
 */
export const isTrialExhaustedError = (message?: string | null): boolean => {
  const parsed = parseTrialMessage(message);
  return !!parsed && (parsed.remaining == null || parsed.remaining === 0);
};

/**
 * Which gated resource the error is about. The message names the model, so prefer that; a single
 * candidate is unambiguous without it. Anything else stays undefined rather than guessing — the alert
 * then offers every gate instead of picking one.
 */
export function pickGateForMessage(
  gates: PurchaseGate[],
  message?: string | null
): PurchaseGate | undefined {
  if (!gates.length) return undefined;
  if (message) {
    const named = gates.filter((gate) =>
      message.toLowerCase().includes(gate.modelName.toLowerCase())
    );
    if (named.length === 1) return named[0];
  }
  return gates.length === 1 ? gates[0] : undefined;
}
