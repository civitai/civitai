import {
  MODEL_RULES_HOLD_DECISIONS,
  MODEL_RULES_HOLD_LABEL,
  parseModelRulesHoldMeta,
  type ModelRulesHoldDecision,
} from '@civitai/moderation/model-rules';
import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { Tracker } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { createStrike } from '~/server/services/strike.service';
import {
  literalModelRules,
  unpublishForModelRules,
} from '~/server/services/text-scan/actions/model-rules';
import { lockModelRulesHold } from '~/server/services/text-scan/actions/model-rules-hold';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';
import { isPublicModel } from '~/server/services/text-scan/public-content';
import { throwConflictError } from '~/server/utils/errorHandling';
import { ModelStatus, StrikeReason } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

export { MODEL_RULES_HOLD_DECISIONS, type ModelRulesHoldDecision };

/**
 * The refusals this service raises on purpose (stale, superseded, moved on, unknown versions, already decided,
 * no owner to strike): their text is safe to show and none is a fault. Any other error, a TRPCError included
 * (the lost-claim conflict above all), is audited as an error.
 */
export class ModelRulesHoldRefusal extends TRPCError {
  constructor(code: 'CONFLICT' | 'BAD_REQUEST', message: string) {
    super({ code, message });
    this.name = 'ModelRulesHoldRefusal';
  }
}

function refuse(message: string, code: 'CONFLICT' | 'BAD_REQUEST' = 'CONFLICT'): never {
  throw new ModelRulesHoldRefusal(code, message);
}

const PLAN: Record<
  ModelRulesHoldDecision,
  { confirm: boolean; strike: boolean; value: 'violation' | 'not_this_subject' | 'allowed_use' }
> = {
  confirm: { confirm: true, strike: false, value: 'violation' },
  confirm_strike: { confirm: true, strike: true, value: 'violation' },
  dismiss_not_subject: { confirm: false, strike: false, value: 'not_this_subject' },
  dismiss_allowed: { confirm: false, strike: false, value: 'allowed_use' },
};

/** The moderator-app grants a decision needs beyond being a moderator: the one the strike action carries elsewhere. */
export const MODEL_RULES_HOLD_DECISION_GRANTS: Partial<
  Record<ModelRulesHoldDecision, 'user.strike'>
> = { confirm_strike: 'user.strike' };

// Shown to the owner in the strike notice; it names no rule.
const STRIKE_DESCRIPTION = 'Content you posted violated our Terms of Service.';
const STRIKE_POINTS = 1;

/** The label-store reason of a batched ruling, so training can tell it from a reviewed one. */
export const MODEL_RULES_HOLD_BATCH_REASON = 'batch_apply';

export const MODEL_RULES_STALE_HOLD_MESSAGE =
  'This hold changed after you opened it (the model text was edited). Reload to review the new text.';
export const MODEL_RULES_SUPERSEDED_MESSAGE =
  'A newer scan replaced this hold. Reload to review the current one.';
const UNKNOWN_VERSIONS_MESSAGE =
  'This hold did not record which versions it took down, so it cannot tell which to republish. Republish the model by hand.';
export const MODEL_RULES_MOVED_ON_MESSAGE =
  'The model is no longer in the state this hold put it in (it was republished, deleted or held for different text), so there is nothing to restore.';

type DecideArgs = {
  holdId: number;
  /** The text hash the moderator reviewed; a hold whose text changed since is refused. */
  textHash: string;
  decision: ModelRulesHoldDecision;
  note?: string;
  actor: Pick<SessionUser, 'id' | 'isModerator'>;
  tracker: Tracker;
  /** Ruled along with other holds of the owner, without the moderator opening this one. */
  batched?: boolean;
};

type HoldEffects = { restored?: true; struck?: true };

function parseEffects(meta: Prisma.JsonValue): HoldEffects {
  const raw = (meta as { effects?: { restored?: unknown; struck?: unknown } } | null)?.effects;
  return {
    ...(raw?.restored === true ? { restored: true as const } : {}),
    ...(raw?.struck === true ? { struck: true as const } : {}),
  };
}

type ModelRow = {
  status: ModelStatus;
  availability: Prisma.ModelGetPayload<object>['availability'];
  deletedAt: Date | null;
  nsfw: boolean;
  meta: Prisma.JsonValue;
};

const isLive = (model: ModelRow) => !model.deletedAt && isPublicModel(model);

/** Hashed the way the detection hashed it, so the two compare. Null when the model is not public. */
async function currentTextHash(modelId: number) {
  const subject = (await loadModelScanSubjects([modelId], { publicOnly: true })).get(modelId);
  return subject ? textScanTextHash(subject) : null;
}

async function dropFromNeedsReview(modelId: number) {
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET "meta" = "meta" - 'needsReview'
    WHERE "id" = ${modelId} AND jsonb_typeof("meta") = 'object' AND "meta" ? 'needsReview'
  `;
  await dataForModelsCache.refresh(modelId);
}

/**
 * Versions this hold's take-down put away: the ones the publish was making public (recorded on the hold) and
 * the ones the take-down stamped. A version taken down for anything else stays down; with neither record the
 * hold cannot say, so the caller refuses.
 */
async function versionsToRestore(modelId: number, model: ModelRow, publishing: number[]) {
  const takenDownAt = (model.meta as { unpublishedAt?: string } | null)?.unpublishedAt;
  const versions = await dbWrite.modelVersion.findMany({
    where: { modelId },
    select: { id: true, meta: true },
  });
  const ids = versions
    .filter(
      (v) =>
        publishing.includes(v.id) ||
        (!!takenDownAt &&
          (v.meta as { unpublishedAt?: string } | null)?.unpublishedAt === takenDownAt)
    )
    .map((v) => v.id);
  return ids.sort((a, b) => a - b);
}

async function restoreModel(
  hold: { entityId: number; textHash: string },
  model: ModelRow | null,
  publishing: number[],
  { actor, tracker }: DecideArgs
) {
  const held = (model?.meta as ModelMeta | null)?.modelRules;
  if (
    !model ||
    model.deletedAt ||
    model.status !== ModelStatus.UnpublishedViolation ||
    held?.textHash !== hold.textHash
  )
    refuse(MODEL_RULES_MOVED_ON_MESSAGE);

  // Dynamic: the controller pulls in the whole model service graph.
  const { publishModelHandler } = await import('~/server/controllers/model.controller');
  const versionIds = await versionsToRestore(hold.entityId, model, publishing);
  if (!versionIds.length) refuse(UNKNOWN_VERSIONS_MESSAGE);
  // As a moderator, so the publish approves the matches (`modelRulesCleared`) and drops the take-down notice.
  await publishModelHandler({
    input: { id: hold.entityId, versionIds },
    ctx: { user: actor as SessionUser, track: tracker },
  });
}

/**
 * A training hold has nothing to restore, and neither has a hold on a model that is neither live nor
 * taken down: the dismissal clears the matched rules for this text instead, which the next
 * training run or publish of it reads.
 */
const clearsRulesInsteadOfRestoring = (model: ModelRow | null, source: 'training' | undefined) =>
  !!model &&
  !model.deletedAt &&
  model.status !== ModelStatus.Deleted &&
  (source === 'training' || (!isLive(model) && model.status !== ModelStatus.UnpublishedViolation));

async function clearModelRules(
  hold: { entityId: number; textHash: string },
  model: ModelRow,
  ruleIds: number[]
) {
  const earlier = (model.meta as ModelMeta | null)?.modelRulesCleared;
  const kept = earlier?.textHash === hold.textHash ? earlier.ruleIds : [];
  const cleared = {
    textHash: hold.textHash,
    ruleIds: [...kept, ...ruleIds.filter((id) => !kept.includes(id))],
  };
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET "meta" = (CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END)
      || jsonb_build_object('modelRulesCleared', ${JSON.stringify(cleared)}::jsonb)
    WHERE "id" = ${hold.entityId}
  `;
}

async function keepModelDown(
  hold: { entityId: number; textHash: string },
  model: ModelRow | null,
  ruleIds: number[],
  { actor, tracker }: DecideArgs
) {
  if (!model || model.deletedAt) return;
  if (!isLive(model)) return dropFromNeedsReview(hold.entityId);
  await unpublishForModelRules({
    entityId: hold.entityId,
    meta: (model.meta ?? {}) as ModelMeta,
    modelRules: literalModelRules(ruleIds, hold.textHash),
    userId: actor.id,
    needsReview: false,
  });
  await tracker.modelEvent({ type: 'Unpublish', modelId: hold.entityId, nsfw: model.nsfw });
}

/** Claims the hold, runs the effects, then records the ruling and its label-store rows in one transaction. A failure releases the claim; a retry skips effects already in `meta.effects`. */
export async function decideModelRulesHold(args: DecideArgs) {
  const { holdId, textHash, decision, note, actor, batched } = args;
  const plan = PLAN[decision];

  const hold = await dbWrite.textScanHold.findFirst({
    where: { id: holdId, label: MODEL_RULES_HOLD_LABEL },
    select: {
      id: true,
      status: true,
      entityType: true,
      entityId: true,
      userId: true,
      text: true,
      textHash: true,
      meta: true,
    },
  });
  if (!hold || hold.entityType !== 'Model') refuse('Hold already decided or missing.');
  const meta = parseModelRulesHoldMeta(hold.meta);
  if (hold.status !== 'Pending')
    refuse(
      meta.decision === 'superseded'
        ? MODEL_RULES_SUPERSEDED_MESSAGE
        : 'Hold already decided or missing.'
    );
  if (hold.textHash !== textHash) refuse(MODEL_RULES_STALE_HOLD_MESSAGE);
  if (plan.strike && !hold.userId)
    refuse('This hold has no recorded owner to strike.', 'BAD_REQUEST');

  const claimed = await dbWrite.$queryRaw<{ at: string }[]>`
    UPDATE "TextScanHold"
    SET "meta" = (CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END)
      || jsonb_build_object('decisionClaim', jsonb_build_object('by', ${actor.id}::int, 'at', now()))
    WHERE "id" = ${holdId} AND "label" = ${MODEL_RULES_HOLD_LABEL} AND "status" = 'Pending'
      AND "textHash" = ${textHash}
      AND ("meta"->'decisionClaim' IS NULL
        OR ("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '5 minutes')
    RETURNING "meta"->'decisionClaim'->>'at' AS "at"
  `;
  if (!claimed.length) refuse('Hold already decided, changed or missing.');

  const status: 'Dismissed' | 'Confirmed' = plan.confirm ? 'Confirmed' : 'Dismissed';
  try {
    const model = (await dbWrite.model.findUnique({
      where: { id: hold.entityId },
      select: { status: true, availability: true, deletedAt: true, nsfw: true, meta: true },
    })) as ModelRow | null;
    const target = { entityId: hold.entityId, textHash: hold.textHash };
    const ruleIds = meta.rules.map((rule) => rule.id);

    // A moderator's edit is not checked, so it can change a live model's text without superseding the hold.
    if (meta.mode === 'shadow' && model && isLive(model)) {
      const current = await currentTextHash(hold.entityId);
      if (current && current !== hold.textHash) refuse(MODEL_RULES_STALE_HOLD_MESSAGE);
    }

    // Effects are not idempotent, so each one is recorded on the hold the moment it completes and a retry
    // skips it instead of striking twice or finding the model already republished.
    const effects: HoldEffects = { ...parseEffects(hold.meta) };
    const done = async (effect: keyof HoldEffects) => {
      effects[effect] = true;
      const written = await dbWrite.$executeRaw`UPDATE "TextScanHold"
        SET "meta" = "meta" || jsonb_build_object('effects',
          coalesce("meta"->'effects', '{}'::jsonb) || jsonb_build_object(${effect}::text, true))
        WHERE "id" = ${holdId} AND "status" = 'Pending' AND "meta"->'decisionClaim'->>'at' = ${claimed[0].at}`;
      // The claim expired or was taken: the effect ran but is unrecorded, so a retry would repeat it.
      if (written !== 1)
        throw throwConflictError('The decision lost its claim on this hold. Reload and check it.');
    };

    if (plan.confirm) await keepModelDown(target, model, ruleIds, args);
    else if (model && clearsRulesInsteadOfRestoring(model, meta.source))
      await clearModelRules(target, model, ruleIds);
    else if (meta.mode === 'active' && !effects.restored) {
      await restoreModel(target, model, meta.versionIds ?? [], args);
      await done('restored');
    }
    const restored = !!effects.restored;
    if (plan.strike && !effects.struck) {
      await strikeOwner(hold, args);
      await done('struck');
    }

    const decidedAt = new Date();
    await dbWrite.$transaction(async (tx) => {
      await lockModelRulesHold(tx, hold.entityId);
      const { count } = await tx.textScanHold.updateMany({
        where: { id: holdId, label: MODEL_RULES_HOLD_LABEL, status: 'Pending', textHash },
        data: {
          status,
          decidedAt,
          decidedById: actor.id,
          decisionNote: note || null,
          ...(restored ? { restoredAt: decidedAt } : {}),
          meta: {
            ...((hold.meta as Prisma.JsonObject | null) ?? {}),
            ...(Object.keys(effects).length ? { effects } : {}),
            decision,
          },
        },
      });
      if (count === 0) refuse('Hold already decided or missing.');

      // Records nothing and returns NULL on bad input rather than raising, so a bad record never undoes the
      // ruling; it lands in `label_store.record_failure`.
      // The snapshot belongs to the subject and the first record keeps it, so it names every matched rule.
      for (const rule of meta.rules)
        await tx.$queryRaw`
          SELECT label_store.record_label(
            p_subject_type => 'model_text',
            p_subject_id => ${String(hold.entityId)},
            p_content_hash => label_store.text_hash(${hold.text}),
            p_family => 'model_rules_hold',
            p_question => 'model_rules.verdict',
            p_value => ${plan.value},
            p_labeller_kind => 'moderator',
            p_source_ref => ${`TextScanHold:${holdId}:rule:${rule.id}`},
            p_labelled_at => ${decidedAt}::timestamptz,
            p_labeller_user_id => ${actor.id}::int,
            p_reason => ${batched ? MODEL_RULES_HOLD_BATCH_REASON : decision},
            p_reason_note => ${note || null},
            p_snapshot => ${JSON.stringify({ text: hold.text, ruleIds })}::jsonb,
            p_owner_user_id => ${hold.userId}::int
          )
        `;
    });
  } catch (error) {
    // Only our own claim, so a takeover after expiry is not undone by a late failure here.
    await dbWrite.$executeRaw`UPDATE "TextScanHold" SET "meta" = "meta" - 'decisionClaim'
        WHERE "id" = ${holdId} AND "status" = 'Pending' AND "meta"->'decisionClaim'->>'at' = ${claimed[0].at}`.catch(
      () => null
    );
    throw error;
  }

  return { status, entityId: hold.entityId, userId: hold.userId };
}

async function strikeOwner(
  hold: { entityId: number; userId: number | null },
  { actor, holdId }: DecideArgs
) {
  await createStrike({
    userId: hold.userId as number,
    // A moderator's call is never rate limited; the other reasons are limited to one a day.
    reason: StrikeReason.ManualModAction,
    points: STRIKE_POINTS,
    description: STRIKE_DESCRIPTION,
    internalNotes: `model rules hold #${holdId}`,
    entityType: 'Model',
    entityId: hold.entityId,
    expiresInDays: 365,
    issuedBy: actor.id,
  });
}

export const isModelRulesHoldRefusal = (error: unknown): error is ModelRulesHoldRefusal =>
  error instanceof ModelRulesHoldRefusal;

export const MODEL_RULES_HOLD_BATCH_MAX = 50;
/** A strike belongs to the owner once, with the hold the moderator is on, never per hold. */
const BATCH_DECISIONS: readonly ModelRulesHoldDecision[] = [
  'confirm',
  'dismiss_not_subject',
  'dismiss_allowed',
];

const holdId = z.coerce.number().int().positive().max(2147483647);
const textHash = z.string().min(1).max(200);

export const resolveModelRulesHoldInput = z
  .object({
    holdId: holdId.optional().describe('The hold to decide. Give this or `holds`, not both.'),
    textHash: textHash
      .optional()
      .describe(
        'The text hash of the hold as the moderator saw it; a hold whose text changed since is refused.'
      ),
    holds: z
      .array(z.object({ holdId, textHash }))
      .min(1)
      .max(MODEL_RULES_HOLD_BATCH_MAX)
      .optional()
      .describe(
        `Several holds decided as one call and one rate-limit hit, each against its own text hash. Never \`confirm_strike\`; at most ${MODEL_RULES_HOLD_BATCH_MAX}.`
      ),
    decision: z.enum(MODEL_RULES_HOLD_DECISIONS),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('Moderator-only note recorded on the hold.'),
  })
  .superRefine((input, ctx) => {
    if ((input.holdId === undefined) === (input.holds === undefined))
      ctx.addIssue({ code: 'custom', message: 'Give exactly one of `holdId` and `holds`.' });
    if (input.holdId !== undefined && input.textHash === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['textHash'],
        message: '`textHash` is required with `holdId`.',
      });
    if (input.holds && !BATCH_DECISIONS.includes(input.decision))
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'A batch cannot strike.',
      });
    if (input.holds && input.textHash !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['textHash'],
        message: 'Each hold of a batch carries its own `textHash`.',
      });
  });

export type ModelRulesHoldBatchResult =
  | {
      holdId: number;
      ok: true;
      status: 'Dismissed' | 'Confirmed';
      entityId: number;
      userId: number | null;
    }
  | { holdId: number; ok: false; stale: boolean; refused: boolean; error: string };

/** Decides each hold on its own, one after the other: a hold that is stale or refused never stops the rest. */
export async function decideModelRulesHoldBatch({
  holds,
  decision,
  note,
  actor,
  tracker,
  decide = decideModelRulesHold,
}: {
  holds: { holdId: number; textHash: string }[];
  decision: ModelRulesHoldDecision;
  note?: string;
  actor: DecideArgs['actor'];
  tracker: Tracker;
  /** Overridable so the loop can be tested without the effects behind a decision. */
  decide?: typeof decideModelRulesHold;
}): Promise<ModelRulesHoldBatchResult[]> {
  const results: ModelRulesHoldBatchResult[] = [];
  for (const hold of new Map(holds.map((h) => [h.holdId, h])).values()) {
    try {
      const decided = await decide({
        holdId: hold.holdId,
        textHash: hold.textHash,
        decision,
        note,
        actor,
        tracker,
        batched: true,
      });
      results.push({ holdId: hold.holdId, ok: true, ...decided });
    } catch (error) {
      // Only our own refusals carry text safe to show.
      const refusal = isModelRulesHoldRefusal(error) ? error : null;
      if (!refusal)
        // Code and name only: a Prisma message can echo the arguments, which here are the held text.
        logToAxiom({
          name: 'text-scan',
          type: 'error',
          message: 'model rules hold batch decision failed',
          holdId: hold.holdId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: (error as { code?: unknown } | null | undefined)?.code,
        }).catch(() => null);
      results.push({
        holdId: hold.holdId,
        ok: false,
        stale: refusal?.message === MODEL_RULES_STALE_HOLD_MESSAGE,
        refused: !!refusal,
        error: refusal?.message ?? 'Could not apply the decision to this hold.',
      });
    }
  }
  return results;
}
