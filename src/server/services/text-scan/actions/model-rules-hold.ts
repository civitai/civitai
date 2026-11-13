import {
  MODEL_RULES_HOLD_LABEL,
  type ModelRulesHoldField,
  type ModelRulesHoldMatch,
  type ModelRulesHoldMode,
  type StoredModelRuleSnapshot,
} from '@civitai/moderation/model-rules';
import { dbWrite } from '~/server/db/client';

const ENTITY_TYPE = 'Model';
const SUPERSEDED_NOTE = 'superseded by a newer scan of the same content';

/** One literal detection, already filtered to the rules not cleared for this text. */
export type ModelRulesHoldDetection = {
  userId: number | null;
  textHash: string;
  text: string;
  reason: string;
  fields: ModelRulesHoldField[];
  matches: ModelRulesHoldMatch[];
  rules: StoredModelRuleSnapshot[];
  mode: ModelRulesHoldMode;
  /** The action was applied at detection, so the hold records `hiddenAt`. */
  applied: boolean;
  /** The versions a publish was making public, kept so a dismissal can publish them. */
  versionIds?: number[];
  /** Set when a training run, not a publish or an edit, made the detection. */
  source?: 'training';
};

export type ModelRulesHoldWrite =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'closed'
  | 'none';

/** Thrown when a detection cannot replace a pending hold because a moderator is mid-decision on it. */
export class ModelRulesHoldBusyError extends Error {
  constructor() {
    super('model rules hold is mid-decision; the detection was not recorded');
    this.name = 'ModelRulesHoldBusyError';
  }
}

/** Advisory lock shared with a decision's final update, so a decision cannot land between the ruled-text check and the write. */
export const lockModelRulesHold = (tx: Pick<typeof dbWrite, '$executeRaw'>, modelId: number) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`model-rules-hold:${ENTITY_TYPE}`}), ${modelId}::int)`;

type PendingRow = {
  id: number;
  textHash: string;
  hiddenAt: Date | null;
  meta: Record<string, unknown> | null;
  claimed: boolean;
};

/**
 * Keeps the model's one pending hold current with the text as it reads now: new text supersedes the
 * pending hold (the new one links back through `priorHoldId`), text that matches nothing closes it as
 * superseded, and text a moderator already ruled on is not held again unless the detection took the model down. Neither closes with a ruling.
 */
export async function syncModelRulesHold(
  modelId: number,
  detection: ModelRulesHoldDetection | null,
  /** A training check closes only a hold a training run wrote: a publish's hold also holds the model down. */
  { onlySource }: { onlySource?: 'training' } = {}
): Promise<ModelRulesHoldWrite> {
  return dbWrite.$transaction(async (tx) => {
    await lockModelRulesHold(tx, modelId);
    const [pending] = await tx.$queryRaw<PendingRow[]>`
      SELECT "id", "textHash", "hiddenAt", "meta",
        coalesce("meta"->'decisionClaim' IS NOT NULL
          AND NOT coalesce(("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes', false),
          false) AS "claimed"
      FROM "TextScanHold"
      WHERE "entityType" = ${ENTITY_TYPE} AND "entityId" = ${modelId}
        AND "label" = ${MODEL_RULES_HOLD_LABEL} AND "status" = 'Pending'
    `;

    if (!detection) {
      if (!pending || (onlySource && pending.meta?.source !== onlySource)) return 'none';
      if (pending.claimed) throw new ModelRulesHoldBusyError();
      return (await supersede(tx, pending)) ? 'closed' : busy();
    }

    const meta = holdMeta(detection);
    if (pending?.textHash === detection.textHash) {
      // The same text, now acted on: record the takedown on the hold the review mode wrote.
      if (!detection.applied || pending.hiddenAt) return 'unchanged';
      const updated = await tx.$executeRaw`
        UPDATE "TextScanHold"
        SET "hiddenAt" = (now() AT TIME ZONE 'UTC'), "meta" = ${JSON.stringify({
          ...pending.meta,
          ...meta,
        })}::jsonb,
            "updatedAt" = now()
        WHERE "id" = ${pending.id} AND "status" = 'Pending' AND "textHash" = ${pending.textHash}
          AND ("meta"->'decisionClaim' IS NULL
          OR coalesce(("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes', false))
      `;
      return updated ? 'updated' : busy();
    }

    if (pending) {
      // The pending hold of a publish is the one that holds the model down; a training run leaves it.
      if (detection.source && pending.meta?.source !== detection.source) return 'skipped';
      if (pending.claimed) throw new ModelRulesHoldBusyError();
      if (!(await supersede(tx, pending))) return busy();
    }

    // A hold superseded just now links the new one; otherwise the latest ruling does. Superseded
    // holds were never ruled on, so they neither block a detection nor mark a re-detection.
    const decided = await tx.$queryRaw<{ id: number; textHash: string }[]>`
      SELECT "id", "textHash" FROM "TextScanHold"
      WHERE "entityType" = ${ENTITY_TYPE} AND "entityId" = ${modelId}
        AND "label" = ${MODEL_RULES_HOLD_LABEL} AND "status" <> 'Pending'
        AND "meta"->>'decision' IS DISTINCT FROM 'superseded'
      ORDER BY "id" DESC
    `;
    // A takedown must reach the queue even for text ruled on before; a detection that acted on nothing need not.
    if (!detection.applied && decided.some((row) => row.textHash === detection.textHash))
      return 'skipped';
    const priorHoldId = pending?.id ?? decided[0]?.id ?? null;

    await tx.$executeRaw`
      INSERT INTO "TextScanHold"
        ("entityType", "entityId", "label", "textHash", "userId", "text", "reason", "hiddenAt",
         "meta", "updatedAt")
      VALUES (${ENTITY_TYPE}, ${modelId}, ${MODEL_RULES_HOLD_LABEL}, ${detection.textHash},
        ${detection.userId}, ${detection.text}, ${detection.reason},
        CASE WHEN ${detection.applied}::boolean THEN now() AT TIME ZONE 'UTC' END,
        ${JSON.stringify(
          priorHoldId === null ? meta : { ...meta, kind: 'redetected', priorHoldId }
        )}::jsonb,
        now())
    `;
    return 'created';
  });
}

function busy(): never {
  throw new ModelRulesHoldBusyError();
}

function holdMeta(detection: ModelRulesHoldDetection) {
  return {
    mode: detection.mode,
    fields: detection.fields,
    matches: detection.matches,
    rules: detection.rules,
    ...(detection.applied ? { applied: true } : {}),
    ...(detection.versionIds?.length ? { versionIds: detection.versionIds } : {}),
    ...(detection.source ? { source: detection.source } : {}),
  };
}

// A decision's claim does not take the model lock, so one can land after the read above; the update
// matches only the row as read and unclaimed, rather than overwrite the claim.
async function supersede(tx: Pick<typeof dbWrite, '$executeRaw'>, pending: PendingRow) {
  return tx.$executeRaw`
    UPDATE "TextScanHold" SET
      "status" = 'Dismissed',
      "decidedAt" = now(),
      "updatedAt" = now(),
      "decisionNote" = ${SUPERSEDED_NOTE},
      "meta" = (CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END)
        || jsonb_build_object('decision', 'superseded', 'superseded', true)
    WHERE "id" = ${pending.id} AND "status" = 'Pending' AND "textHash" = ${pending.textHash}
      AND ("meta"->'decisionClaim' IS NULL
          OR coalesce(("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes', false))
  `;
}
