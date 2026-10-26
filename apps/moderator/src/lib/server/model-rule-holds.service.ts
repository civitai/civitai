import { sql } from '@civitai/db/kysely';
import { BATCH_MAX, expectedStatus, type ModelRuleHoldDecision } from '$lib/model-rule-holds';
import { dbRead } from './db';
import { modelFactsJoin } from './minor-hash.service';
import { filterOwnerPendingHolds } from './model-rule-holds.queries';
import { callModEndpoint, type ModEndpoint } from './user-actions.service';

export {
  countModelRuleHoldsByRule,
  countPendingModelRuleHolds,
  getModelRuleHoldHistory,
  getOwnerRuleHolds,
  listModelRuleHolds,
  modelRuleHoldSearch,
  type ModelRuleHoldHistoryEntry,
  type ModelRuleHoldRow,
  type OwnerRuleHolds,
} from './model-rule-holds.queries';

const RESOLVE: ModEndpoint = 'text-scan/model-rules-hold/resolve';

const MAY_HAVE_COMPLETED =
  'Could not confirm the decision. It may already have completed — reload the queue before retrying.';

export type ModelRuleHoldDecisionResult = { ok: true } | { ok: false; error: string };

/** The main app applies the ruling, and whatever it does to the model, with the hold in one step. */
export async function decideModelRuleHold({
  holdId,
  textHash,
  decision,
  note,
}: {
  holdId: number;
  /** The hold's `textHash` as the moderator saw it; the main app refuses the decision if the text changed since. */
  textHash: string;
  decision: ModelRuleHoldDecision;
  note?: string;
}): Promise<ModelRuleHoldDecisionResult> {
  const result = await callModEndpoint(
    RESOLVE,
    { holdId, textHash, decision, ...(note ? { note } : {}) },
    'Decide model rule hold'
  );
  if (!result.ok) {
    // Nobody answered, yet the request left: the main app may have applied it.
    if (!result.requestNeverSent && result.status === undefined)
      return { ok: false, error: MAY_HAVE_COMPLETED };
    return { ok: false, error: result.error };
  }
  const expected = expectedStatus(decision);
  if (result.body.status !== expected)
    return {
      ok: false,
      error: `The main app did not report the hold as ${expected.toLowerCase()}.`,
    };
  return { ok: true };
}

export type OwnerHoldTarget = { holdId: number; textHash: string };
export type OwnerHoldResult = { holdId: number; ok: boolean; error?: string };

/** The owner's strike is applied once, with the hold the moderator is on; the others are only taken down. */
export const decisionForOtherHolds = (decision: ModelRuleHoldDecision): ModelRuleHoldDecision =>
  decision === 'confirm_strike' ? 'confirm' : decision;

// The main app decides the holds one after another inside one request.
const BATCH_TIMEOUT_MS = 120_000;

type BatchEntry = { holdId: number; ok: boolean; status?: string; error?: string };

/** Decides the owner's other pending holds, each against the hash its listing gave; a changed hold is reported, never forced. Call only after the on-screen hold is decided, so a refused strike never leaves the others decided. */
export async function decideOwnerHolds({
  holdId,
  also,
  decision,
  note,
}: {
  holdId: number;
  also: OwnerHoldTarget[];
  decision: ModelRuleHoldDecision;
  note?: string;
}): Promise<OwnerHoldResult[]> {
  const targets = [...new Map(also.map((hold) => [hold.holdId, hold])).values()].filter(
    (hold) => hold.holdId !== holdId
  );
  const sameOwner = new Set(
    (
      await filterOwnerPendingHolds(
        holdId,
        targets.map((hold) => hold.holdId)
      )
    ).map((hold) => hold.id)
  );
  const outcome = new Map<number, OwnerHoldResult>();
  for (const target of targets)
    if (!sameOwner.has(target.holdId))
      outcome.set(target.holdId, {
        holdId: target.holdId,
        ok: false,
        error: 'Not a pending hold of the same owner.',
      });
  const decidable = targets.filter((target) => sameOwner.has(target.holdId));
  for (const target of decidable.slice(BATCH_MAX))
    outcome.set(target.holdId, {
      holdId: target.holdId,
      ok: false,
      error: 'Too many holds at once.',
    });

  const batch = decidable.slice(0, BATCH_MAX);
  if (batch.length)
    for (const result of await decideBatch(batch, decisionForOtherHolds(decision), note))
      outcome.set(result.holdId, result);
  return targets.map((target) => outcome.get(target.holdId)!);
}

async function decideBatch(
  batch: OwnerHoldTarget[],
  decision: ModelRuleHoldDecision,
  note: string | undefined
): Promise<OwnerHoldResult[]> {
  const expected = expectedStatus(decision);
  const response = await callModEndpoint(
    RESOLVE,
    { holds: batch, decision, ...(note ? { note } : {}) },
    'Decide model rule holds',
    BATCH_TIMEOUT_MS
  );
  if (!response.ok) {
    const error =
      !response.requestNeverSent && response.status === undefined
        ? MAY_HAVE_COMPLETED
        : response.error;
    return batch.map((hold) => ({ holdId: hold.holdId, ok: false, error }));
  }
  const reported = new Map(
    (Array.isArray(response.body.results) ? (response.body.results as BatchEntry[]) : []).map(
      (entry) => [entry.holdId, entry]
    )
  );
  return batch.map(({ holdId }) => {
    const entry = reported.get(holdId);
    if (entry?.ok && entry.status === expected) return { holdId, ok: true };
    const error = entry?.ok
      ? `The main app did not report the hold as ${expected.toLowerCase()}.`
      : entry?.error ?? 'The main app did not report this hold.';
    return { holdId, ok: false, error };
  });
}

export type HoldModelFacts = {
  baseModel: string | null;
  trainedWords: string[];
  trainedWordCount: number;
  tags: string[];
  tagCount: number;
};

/** The facts `ModelFactsCard` shows for each model, in one read bounded by the page. */
export async function getHoldModelFacts(modelIds: number[]): Promise<Map<number, HoldModelFacts>> {
  const ids = [...new Set(modelIds)];
  if (!ids.length) return new Map();
  const { rows } = await sql<HoldModelFacts & { modelId: number }>`
    WITH pg AS (SELECT m.id AS "modelId" FROM "Model" m WHERE m.id IN (${sql.join(ids)}))
    SELECT pg."modelId", v."baseModel", COALESCE(v."trainedWords", '{}') AS "trainedWords",
           COALESCE(v."trainedWordCount", 0) AS "trainedWordCount",
           COALESCE(t.tags, '{}') AS tags, COALESCE(t."tagCount", 0) AS "tagCount"
    FROM pg
    ${modelFactsJoin}`.execute(dbRead);
  return new Map(rows.map(({ modelId, ...facts }) => [modelId, facts]));
}
