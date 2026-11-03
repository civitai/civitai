import crypto from 'crypto';
import type { Workflow, XGuardModerationStep } from '@civitai/orchestration-client';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { isImageMetaOnSite } from '~/server/utils/image-onsite';

/**
 * Shadow evaluation of an uploaded image's prompt by XGuard prompt mode. Records what
 * "a sexual prompt rates the image at least R" WOULD set beside the rating the image has.
 * Nothing here writes to an image, its tags or its review state.
 */

const SHADOW_KIND = 'sexual-prompt';
const LABEL = 'Sexual';
const NEGATIVE_FIELD = 'Negative Prompt';
export const SHADOW_SEXUAL_PROMPT_QUESTION = 'image.prompt_sexual';

const shadowMetadataSchema = z.object({
  kind: z.literal(SHADOW_KIND),
  imageId: z.number().int().positive(),
  currentNsfwLevel: z.number().int().nonnegative(),
  onSite: z.boolean(),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ShadowSexualPromptMetadata = z.infer<typeof shadowMetadataSchema>;

/** The shadow marker on a workflow's metadata, or null when it is absent or malformed. */
export function readShadowSexualPromptMetadata(
  metadata: Record<string, unknown> | null | undefined
): ShadowSexualPromptMetadata | null {
  const parsed = shadowMetadataSchema.safeParse(metadata?.shadow);
  return parsed.success ? parsed.data : null;
}

/**
 * Until the orchestrator accepts a positive-only scope, both prompts are sent; a fire that the
 * model attributes to the negative prompt is not a sexual prompt.
 */
export function countsAsSexualPrompt(result: { triggered: boolean; field?: string | null }) {
  return result.triggered && result.field !== NEGATIVE_FIELD;
}

export function wouldNsfwLevel(currentNsfwLevel: number, sexualPrompt: boolean) {
  return sexualPrompt ? Math.max(currentNsfwLevel, NsfwLevel.R) : currentNsfwLevel;
}

export function hashPromptPair(positivePrompt: string, negativePrompt: string | undefined) {
  return crypto
    .createHash('sha256')
    .update(`${positivePrompt}\n${negativePrompt ?? ''}`, 'utf8')
    .digest('hex');
}

function readPrompts(meta: unknown) {
  if (!meta || typeof meta !== 'object') return null;
  const { prompt, negativePrompt } = meta as Record<string, unknown>;
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  return {
    positivePrompt: prompt,
    negativePrompt:
      typeof negativePrompt === 'string' && negativePrompt ? negativePrompt : undefined,
  };
}

/** Submits the sampled shadow scan. Resolves once submitted; the verdict arrives by callback. */
export async function submitShadowSexualPromptScan(image: {
  id: number;
  type: string;
  meta: unknown;
  nsfwLevel: number;
}) {
  if (image.type !== 'image') return;
  const prompts = readPrompts(image.meta);
  if (!prompts) return;
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SHADOW_SEXUAL_PROMPT, String(image.id)))) return;

  const shadow: ShadowSexualPromptMetadata = {
    kind: SHADOW_KIND,
    imageId: image.id,
    currentNsfwLevel: image.nsfwLevel,
    onSite: isImageMetaOnSite(image.meta),
    promptHash: hashPromptPair(prompts.positivePrompt, prompts.negativePrompt),
  };
  await createXGuardModerationRequest({
    mode: 'prompt',
    ...prompts,
    labels: [LABEL],
    priority: 'low',
    recordForReview: false,
    extraMetadata: { shadow },
  });
}

export function logShadowSexualPromptError(error: unknown, imageId?: number) {
  logToAxiom({
    type: 'error',
    name: 'shadow-sexual-prompt',
    message: error instanceof Error ? error.message : String(error),
    imageId,
  }).catch(() => undefined);
}

function toClickHouseDateTime(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Callback side: one ClickHouse row and one label-store prediction. Never touches the image. */
export async function recordShadowSexualPrompt(
  workflow: Workflow,
  shadow: ShadowSexualPromptMetadata
) {
  const steps = (workflow.steps ?? []) as unknown as XGuardModerationStep[];
  const result = steps
    .find((s) => s.$type === 'xGuardModeration')
    ?.output?.results.find((r) => r.label.toLowerCase() === LABEL.toLowerCase());
  if (!result || !workflow.id) {
    logShadowSexualPromptError(new Error(`no ${LABEL} result on ${workflow.id}`), shadow.imageId);
    return;
  }

  const sexualPrompt = countsAsSexualPrompt(result);
  const would = wouldNsfwLevel(shadow.currentNsfwLevel, sexualPrompt);
  const scannedAt = workflow.completedAt ? new Date(workflow.completedAt) : new Date();
  const policyHash = result.policyHash ?? '';

  await Promise.all([
    writeClickHouseRow({
      imageId: shadow.imageId,
      promptHash: shadow.promptHash,
      workflowId: workflow.id,
      score: result.score,
      threshold: result.threshold,
      triggered: result.triggered ? 1 : 0,
      field: result.field ?? '',
      currentNsfwLevel: shadow.currentNsfwLevel,
      wouldNsfwLevel: would,
      wouldRaise: would > shadow.currentNsfwLevel ? 1 : 0,
      onSite: shadow.onSite ? 1 : 0,
      policyHash,
      modelVersion: String(workflow.metadata?.version ?? ''),
      scannedAt: toClickHouseDateTime(scannedAt),
    }).catch((e) => logShadowSexualPromptError(e, shadow.imageId)),
    recordPrediction({
      shadow,
      workflowId: workflow.id,
      result,
      sexualPrompt,
      would,
      policyHash,
      scannedAt,
    }).catch((e) => logShadowSexualPromptError(e, shadow.imageId)),
  ]);
}

async function writeClickHouseRow(row: Record<string, string | number>) {
  if (!clickhouse) return;
  await clickhouse.insert({
    table: 'shadow_sexual_prompt_results',
    values: [row],
    format: 'JSONEachRow',
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 0 },
  });
}

async function recordPrediction(args: {
  shadow: ShadowSexualPromptMetadata;
  workflowId: string;
  result: { score: number; threshold: number; triggered: boolean; field?: string | null };
  sexualPrompt: boolean;
  would: number;
  policyHash: string;
  scannedAt: Date;
}) {
  const { shadow, result } = args;
  const detail = {
    field: result.field ?? null,
    triggered: result.triggered,
    onSite: shadow.onSite,
    currentNsfwLevel: shadow.currentNsfwLevel,
    wouldNsfwLevel: args.would,
  };
  await dbWrite.$queryRaw`
    SELECT label_store.record_prediction(
      p_subject_type => 'image',
      p_subject_id => ${String(shadow.imageId)}::text,
      p_content_hash => label_store.text_hash(i."url"),
      p_family => 'xguard_prompt',
      p_question => ${SHADOW_SEXUAL_PROMPT_QUESTION}::text,
      p_value => ${args.sexualPrompt ? 'sexual' : 'not_sexual'}::text,
      p_model_ref => ${`xguard-prompt@${args.policyHash}`}::text,
      p_source_ref => ${`ShadowSexualPrompt:${args.workflowId}`}::text,
      p_predicted_at => ${args.scannedAt}::timestamptz,
      p_question_version => 1,
      p_confidence => ${result.score}::real,
      p_scores => ${JSON.stringify({ sexual: result.score })}::jsonb,
      p_versions => ${JSON.stringify({
        policy: args.policyHash,
        threshold: result.threshold,
      })}::jsonb,
      p_input_hash => ${shadow.promptHash}::text,
      p_detail => ${JSON.stringify(detail)}::jsonb,
      p_snapshot => jsonb_build_object('url', i."url"),
      p_phash => i."pHash",
      p_owner_user_id => i."userId"
    )
    FROM "Image" i
    WHERE i.id = ${shadow.imageId}::int
  `;
}
