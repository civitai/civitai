import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import type { TrainingStepTemplate } from '@civitai/orchestration-client';
import { OrchPriorityTypes } from '~/server/common/enums';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { BlockTrainingBody } from '~/server/schema/blocks/workflow.schema';
import type { AiToolkitTrainingParams } from '~/server/schema/orchestrator/training.schema';
import {
  BLOCK_QUOTE_GRANT_TTL_SECONDS,
  claimQuoteGrant,
  hashQuotedBody,
  readQuoteGrant,
  recordQuoteGrantConsent,
  storeQuoteGrant,
  type BlockQuoteBinding,
  type BlockQuoteGrantRecord,
} from '~/server/services/blocks/block-quote-grant.service';
import { buildAiToolkitTrainingStep } from '~/server/services/orchestrator/training/training.orch';
import {
  getTrainingFields,
  isAiToolkitEnabled,
  isInvalidAiToolkit,
  trainingBaseModelTypesImage,
  trainingModelInfo,
} from '~/utils/training';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks `kind:'training'` — run resolution and the QUOTE record.
//
// The estimate resolves a training body into one orchestrator step, prices it with
// a `whatif`, and stores the price here keyed by an opaque `quoteId`. The viewer
// confirms THAT price from their own signed-in session (`consentTrainingQuote`),
// and the submit claims the record exactly once and charges against it. Nothing in
// this file trusts a number the block supplied.
//
// The store itself — binding, TTL, consent write, consume-once claim — is
// `block-quote-grant.service`, shared with the confirmed pass-through step; this file
// adds only what is training-specific: run resolution and the RUN-keyed identity.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a training quote stays usable — consent and submit must both land inside it. */
export const BLOCK_TRAINING_QUOTE_TTL_SECONDS = BLOCK_QUOTE_GRANT_TTL_SECONDS;

export type BlockTrainingQuoteRecord = BlockQuoteGrantRecord & {
  /** The dataset's blob keys, as the body named them — what the confirming host checks. */
  itemKeys: string[];
  imageCount: number;
  /** The `trainingModelInfo` key and its display name, for the consent dialog. */
  modelKey: string;
  modelName: string;
  ecosystem: string;
  epochs: number | null;
  steps: number | null;
};

/**
 * The hash that binds a quote to the body it priced. `quoteId` is excluded — it is
 * the one field the submit adds — and everything else must be identical.
 */
export function hashTrainingBody(body: BlockTrainingBody): string {
  return hashQuotedBody(body);
}

/**
 * The identity of a training RUN — app, every body field (the dataset included) and
 * that body's run generation (`readTrainingRunGeneration`) — as a sha256 hex digest. Retries of one run share it; it keys the
 * run's idempotency claim and orchestrator `externalId` (which the orchestrator
 * dedupes per `(userId, externalId)`).
 */
export function trainingRunKey(
  appBlockId: string,
  body: BlockTrainingBody,
  generation: number
): string {
  return createHash('sha256')
    .update(`${appBlockId}\n${hashTrainingBody(body)}\n${generation}`)
    .digest('hex');
}

/** Who a run belongs to — every field from VERIFIED token claims. */
export type BlockTrainingRunOwner = { userId: number; appBlockId: string };

// Per (viewer, app, body): a definite submit of one body must not change the run key
// of another body's pending retry.
function runGenerationKey(
  owner: BlockTrainingRunOwner,
  body: BlockTrainingBody
): `${typeof REDIS_SYS_KEYS.BLOCKS.TRAINING_RUNS}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.TRAINING_RUNS}:${owner.userId}:${
    owner.appBlockId
  }:${hashTrainingBody(body)}`;
}

/**
 * How many runs of this body this viewer has SUBMITTED from this app. Part of the run
 * key, so a deliberate re-run after a known result is a new run, while a retry after
 * an ambiguous failure (no bump) still dedupes onto the run that may exist.
 */
export async function readTrainingRunGeneration(
  owner: BlockTrainingRunOwner,
  body: BlockTrainingBody
): Promise<number> {
  const raw = await sysRedis.get(runGenerationKey(owner, body));
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export const TRAINING_RUN_GENERATION_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Record a submitted run. Best-effort: a lost bump only makes the next re-run dedupe. */
export async function bumpTrainingRunGeneration(
  owner: BlockTrainingRunOwner,
  body: BlockTrainingBody
): Promise<void> {
  try {
    await sysRedis.incrBy(runGenerationKey(owner, body), 1);
    await sysRedis.expire(runGenerationKey(owner, body), TRAINING_RUN_GENERATION_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

/** Training-service status, as `getTrainingServiceStatus` returns it. */
export type TrainingServiceStatus = {
  available: boolean;
  message?: string | null;
  blockedModels?: string[] | null;
};

export type ResolvedBlockTrainingRun = {
  /** The step to quote AND submit — the same object for both. */
  step: TrainingStepTemplate;
  modelKey: string;
  modelName: string;
  ecosystem: string;
  epochs: number | null;
  steps: number | null;
};

function refuse(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

/**
 * Resolve a training body into the one step a quote and a submit both use, applying
 * the training form's server-side gates.
 *
 * PURE — no I/O. Every input that can change between the estimate and the submit
 * (service status, feature flags) is passed in, so the submit re-runs this with
 * fresh values rather than trusting the estimate's.
 *
 * The gates, in order: the training service is available (moderators excepted, as
 * on the training form); the base model is a known, enabled catalog entry with an
 * ai-toolkit configuration; it trains an IMAGE base type (the dataset is images);
 * the body's ecosystem/variant are that entry's; the model is not blocked from
 * training; ai-toolkit is valid and enabled for it; and `continueFrom` is absent
 * (continuing from an existing checkpoint is not part of v1).
 */
export function resolveBlockTrainingRun(input: {
  body: BlockTrainingBody;
  status: TrainingServiceStatus;
  features: Record<string, boolean | undefined>;
  isModerator: boolean;
}): ResolvedBlockTrainingRun {
  const { body, status, isModerator } = input;
  const features = input.features as Record<string, boolean>;

  if (!status.available && !isModerator) {
    refuse(status.message ?? 'Training is currently disabled');
  }

  // Own-property lookup: a prototype key (`toString`) must not resolve to a model.
  if (!Object.prototype.hasOwnProperty.call(trainingModelInfo, body.model)) {
    refuse('unknown training base model');
  }
  const modelKey = body.model as keyof typeof trainingModelInfo;
  const info = trainingModelInfo[modelKey];
  if (info.disabled) refuse('this base model is not available for training');
  if (!info.aiToolkit) refuse('this base model does not support ai-toolkit training');
  if (!(trainingBaseModelTypesImage as readonly string[]).includes(info.type)) {
    refuse('only image training is supported for apps');
  }
  const params = body.params;
  if (
    params.ecosystem !== info.aiToolkit.ecosystem ||
    (params.modelVariant ?? undefined) !== (info.aiToolkit.modelVariant ?? undefined)
  ) {
    refuse('params.ecosystem / params.modelVariant do not match the base model');
  }
  if ((status.blockedModels ?? []).includes(modelKey)) {
    refuse('This model has been blocked from training - please try another one.');
  }
  if (isInvalidAiToolkit(info.type, 'ai-toolkit')) {
    refuse('AI Toolkit training is not supported for this model.');
  }
  if (!isAiToolkitEnabled(info.type, features)) {
    refuse('AI Toolkit training is not currently enabled for this base model.');
  }
  if (params.continueFrom !== undefined) {
    refuse('continuing from a checkpoint is not supported for app training');
  }

  // Same rule as the training form's submit: without the steps-pricing flag the
  // steps-pricing fields are stripped and the run is priced per epoch.
  let effectiveParams: AiToolkitTrainingParams = params;
  if (!features.trainingStepsPricing) {
    const {
      steps: _steps,
      batchSize: _batchSize,
      sampleCfgScale: _cfg,
      sampleStrength: _strength,
      ...legacy
    } = params;
    effectiveParams = legacy as AiToolkitTrainingParams;
  }

  const step = buildAiToolkitTrainingStep({
    model: getTrainingFields.getModel(modelKey),
    priority: OrchPriorityTypes.Low,
    triggerWord: body.triggerWord,
    trainingData: {
      type: 'blobs',
      items: body.items.map((item) => ({ air: item.air, caption: item.caption })),
    },
    // Same fallback as the training form's submit when no prompts were given.
    samplePrompts: body.samplePrompts.length > 0 ? body.samplePrompts : ['', '', ''],
    params: effectiveParams,
  });

  return {
    step,
    modelKey,
    modelName: info.pretty,
    ecosystem: params.ecosystem,
    epochs: effectiveParams.epochs ?? null,
    steps: effectiveParams.steps ?? null,
  };
}

/**
 * Store a fresh quote. The `quoteId` is server-minted (128 random bits) and the
 * record starts UNCONSENTED.
 */
export function storeTrainingQuote(
  input: Omit<
    BlockTrainingQuoteRecord,
    'v' | 'quoteId' | 'expiresAt' | 'consentedBy' | 'consentedAt'
  >
): Promise<BlockTrainingQuoteRecord> {
  return storeQuoteGrant<BlockTrainingQuoteRecord>('training', input);
}

/**
 * Read a quote FOR THIS subject, app and install, or `null` (absent, expired,
 * malformed, or bound to someone else — one answer for all, so a quote id cannot
 * be used to probe another viewer's runs). Does not consume it.
 */
export function readTrainingQuote(
  quoteId: string,
  binding: BlockQuoteBinding
): Promise<BlockTrainingQuoteRecord | null> {
  return readQuoteGrant<BlockTrainingQuoteRecord>('training', quoteId, binding);
}

/**
 * Record that `sessionUserId` confirmed this quote. `null` when the quote is not
 * readable for this binding or the session user is not its own subject. Keeps the
 * remaining TTL and never resurrects a claimed quote — see `recordQuoteGrantConsent`.
 */
export function recordTrainingQuoteConsent(
  quoteId: string,
  binding: BlockQuoteBinding,
  sessionUserId: number
): Promise<BlockTrainingQuoteRecord | null> {
  return recordQuoteGrantConsent<BlockTrainingQuoteRecord>(
    'training',
    quoteId,
    binding,
    sessionUserId
  );
}

/**
 * Claim a quote for a submit — EXACTLY ONCE (atomic `GETDEL`). The record is consumed
 * whatever the caller then decides, so a submit refused for any reason needs a fresh
 * quote and a fresh confirmation.
 */
export function claimTrainingQuote(quoteId: string): Promise<BlockTrainingQuoteRecord | null> {
  return claimQuoteGrant<BlockTrainingQuoteRecord>('training', quoteId);
}
