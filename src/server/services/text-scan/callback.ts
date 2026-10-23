import { getWorkflow } from '@civitai/orchestration-client';
import type { StoredModelRules } from '@civitai/moderation/model-rules';
import { logToAxiom } from '~/server/logging/client';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import {
  mergeTextScanOutputs,
  stricterThanStored,
  type FlaggedSegments,
} from '~/server/services/text-scan/merge';
import {
  getTextScanMode,
  isTextScanWebSearchEntityType,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { parseTextScanSteps } from '~/server/services/text-scan/parse';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  filterModelRuleMatches,
  getModelRuleSnapshots,
} from '~/server/services/text-scan/model-rules';
import {
  readTextScanVerdict,
  recordTextScanFailure,
  recordTextScanRaise,
  revertTextScanRaise,
  recordTextScanSuccess,
} from '~/server/services/text-scan/record';
import type { PromptIds, TextScanLabel, TextScanOutput } from '~/server/services/text-scan/types';
import { logScanVerdict } from '~/server/services/text-scan/verdict-log';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

const failureStatus = {
  failed: EntityModerationStatus.Failed,
  expired: EntityModerationStatus.Expired,
  canceled: EntityModerationStatus.Canceled,
} as const;

function log(type: 'error' | 'warning' | 'info', message: string, extra: Record<string, unknown>) {
  return logToAxiom({ name: 'text-scan', type, message, ...extra });
}

type TextScanWorkflowMetadata = {
  entityType?: string;
  entityId?: number;
  emEntityType?: string;
  mode?: string;
  variant?: string;
  externalId?: string;
  labels?: TextScanLabel[];
  promptIds?: PromptIds;
  model?: string;
  textHash?: string;
  subjectMeta?: Record<string, unknown>;
  ruleIds?: number[];
  rulesFingerprint?: string;
  literalRuleIds?: number[];
  inputChars?: number;
  inputCut?: boolean;
  segments?: number;
  scannedChars?: number;
};

/** Workflows submitted before segmentation carry no `segments` and hold one step. */
function expectedSegments({ segments }: TextScanWorkflowMetadata) {
  return Number.isInteger(segments) && (segments as number) > 0 ? (segments as number) : 1;
}

/**
 * Narrows the merged `modelRules` match to rules the prompt listed that are still live, in place.
 * Every path that acts on a verdict goes through here, so a rule the prompt never carried, or one
 * disabled since the submit, can never unpublish a model.
 */
async function scopeModelRules(
  output: TextScanOutput,
  metadata: TextScanWorkflowMetadata,
  ctx: Record<string, unknown>
): Promise<StoredModelRules | undefined> {
  if (!output.modelRules) return undefined;
  const { kept, dropped } = filterModelRuleMatches(output.modelRules.matched, metadata.ruleIds);
  if (dropped.length)
    await log('warning', 'matched rule ids the prompt did not list', { ...ctx, dropped });
  const listed = new Set(metadata.ruleIds);
  const literalCandidates = (metadata.literalRuleIds ?? []).filter((id) => listed.has(id));
  const snapshot = await getModelRuleSnapshots([
    ...new Set([...kept.map((m) => m.ruleId), ...literalCandidates]),
  ]);
  const live = new Set(snapshot.map((rule) => rule.id));
  output.modelRules = { matched: kept.filter((m) => live.has(m.ruleId)) };
  return {
    fingerprint: metadata.rulesFingerprint,
    snapshot,
    literalRuleIds: literalCandidates.filter((id) => live.has(id)),
  };
}

function inputMeta(metadata: TextScanWorkflowMetadata, flaggedSegments: FlaggedSegments) {
  if (metadata.inputChars === undefined) return undefined;
  return {
    inputChars: metadata.inputChars,
    inputCut: metadata.inputCut ?? false,
    ...(metadata.segments === undefined
      ? {}
      : {
          segments: expectedSegments(metadata),
          scannedChars: metadata.scannedChars ?? metadata.inputChars,
        }),
    ...(Object.keys(flaggedSegments).length ? { flaggedSegments } : {}),
  };
}

export async function handleTextScanCallback(event: { workflowId: string; status: string }) {
  const { workflowId } = event;
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${workflowId}`);

  const metadata = (data.metadata ?? {}) as TextScanWorkflowMetadata;
  const { entityType, entityId, mode } = metadata;
  if (
    !(data.tags ?? []).includes('text-scan') ||
    (mode !== 'shadow' && mode !== 'active') ||
    !entityType ||
    entityId === undefined ||
    !isTextScanEntityType(entityType)
  ) {
    await log('warning', 'callback for a workflow text-scan does not own', {
      workflowId,
      entityType,
      mode,
    });
    return;
  }
  const variant = metadata.variant;
  if (
    variant !== undefined &&
    (variant !== 'web-search' || !isTextScanWebSearchEntityType(entityType))
  ) {
    await log('warning', 'callback for an unknown text-scan pass', {
      workflowId,
      entityType,
      variant,
    });
    return;
  }
  const emEntityType = textScanEmEntityType(entityType, mode, variant);
  if (metadata.emEntityType !== undefined && metadata.emEntityType !== emEntityType) {
    await log('warning', 'callback row key disagrees with its mode', {
      workflowId,
      entityType,
      mode,
      emEntityType: metadata.emEntityType,
    });
    return;
  }
  const marker = metadata.externalId;
  const submittedActive = mode === 'active';
  const ctx = { workflowId, entityType, entityId, emEntityType };

  // After a rollback the old pipeline owns the live row again. Gate every pass, search included, on
  // the main mode only: after a search-only rollback the main scan has stopped asking for poi/minor,
  // so dropping this search verdict would leave that edit with no poi/minor verdict at all.
  if (submittedActive && (await getTextScanMode(entityType, entityId)) !== 'active')
    return log('info', 'mode left active before the callback; live row not written', ctx);

  // Shadow verdicts must not drive the live adapter's failure hooks either (e.g. Article ingestion).
  const adapter = submittedActive ? getModerationAdapter(entityType) : undefined;
  // The search pass only ever adds poi/minor; failures stay the main pass's business.
  const failureAdapter = variant ? undefined : adapter;

  if (event.status && Object.hasOwn(failureStatus, event.status)) {
    const status = event.status as keyof typeof failureStatus;
    const recorded = await recordTextScanFailure({
      entityType: emEntityType,
      entityId,
      workflowId,
      marker,
      status: failureStatus[status],
    });
    if (!recorded) return log('warning', 'stale callback ignored', ctx);
    await log(status === 'failed' ? 'error' : 'warning', `workflow ${status}`, ctx);
    await failureAdapter?.applyFailure?.({ entityId, workflowId, status });
    return;
  }
  if (event.status !== 'succeeded')
    return log('warning', `unexpected workflow status: ${event.status}`, ctx);

  const profile = getTextScanProfile(entityType);
  if (!profile) return log('error', 'no profile registered', ctx);
  const labels = metadata.labels ?? profile.labels;

  const segments = expectedSegments(metadata);
  const parsed = parseTextScanSteps(data.steps, labels, segments);
  // The scan stays Failed for the retry job, but what the parsed segments found already holds for
  // the whole text, so it may raise the stored verdict now; it never lowers or clears it.
  const raisePartialVerdict = async (outputs: TextScanOutput[]) => {
    const subject = (await profile.load([entityId])).get(entityId);
    if (!subject || subject.notPublic) return;
    const stored = await readTextScanVerdict({
      entityType: emEntityType,
      entityId,
      workflowId,
    });
    if (!stored) return;
    const { output: merged } = mergeTextScanOutputs(outputs, labels);
    const modelRules = await scopeModelRules(merged, metadata, ctx);
    const raised = stricterThanStored(stored, merged, labels);
    if (!raised.length) return;
    const output: TextScanOutput = Object.fromEntries(
      raised.map((label) => [label, merged[label]])
    );
    const outcome = evaluateTextScan(output, subject.declared, raised);
    const recorded = await recordTextScanRaise({
      entityType: emEntityType,
      entityId,
      workflowId,
      stored,
      outcome,
      output,
      promptIds: metadata.promptIds ?? {},
      model: metadata.model ?? '',
      textHash: metadata.textHash,
      meta: metadata.subjectMeta ?? subject.meta,
      modelRules,
    });
    if (!recorded) return;
    await log('warning', 'partial verdict raised', {
      ...ctx,
      raised,
      parsedSegments: outputs.length,
      segments,
      acted: !!adapter?.applyTextScan && outcome.triggeredLabels.length > 0,
    });
    if (!outcome.triggeredLabels.length && !outcome.nsfw) return;
    try {
      await adapter?.applyTextScan?.({
        entityId,
        workflowId,
        outcome,
        subject,
        textHash: metadata.textHash ?? textScanTextHash(subject),
        promptIds: metadata.promptIds,
      });
    } catch (error) {
      // Left raised, the next callback would find nothing stricter and never act on it.
      const reverted = await revertTextScanRaise({
        entityType: emEntityType,
        entityId,
        workflowId,
        stored,
      });
      await log('error', 'applying the partial verdict failed', {
        ...ctx,
        reverted,
        error: (error as Error).message,
      });
      throw error;
    }
  };

  if (!parsed.ok) {
    const recorded = await recordTextScanFailure({
      entityType: emEntityType,
      entityId,
      workflowId,
      marker,
      status: EntityModerationStatus.Failed,
    });
    if (!recorded) return log('warning', 'stale callback ignored', ctx);
    await log('warning', 'unusable output', {
      ...ctx,
      reason: parsed.reason,
      detail: parsed.detail,
      ...(parsed.segment === undefined ? {} : { segment: parsed.segment }),
      segments,
    });
    try {
      if (parsed.outputs.length) await raisePartialVerdict(parsed.outputs);
    } finally {
      await failureAdapter?.applyFailure?.({ entityId, workflowId, status: 'failed' });
    }
    return;
  }

  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return log('info', 'entity gone before callback', ctx);
  // Failed, not a verdict: a Succeeded row with this content hash would dedupe the publish rescan.
  // The retry cron parks it until that rescan re-arms it.
  if (subject.notPublic) {
    const recorded = await recordTextScanFailure({
      entityType: emEntityType,
      entityId,
      workflowId,
      marker,
      status: EntityModerationStatus.Failed,
    });
    if (!recorded) return log('warning', 'stale callback ignored', ctx);
    return log('info', 'subject not public; verdict dropped', ctx);
  }

  const { output, flaggedSegments } = mergeTextScanOutputs(parsed.outputs, labels);

  const modelRules = await scopeModelRules(output, metadata, ctx);

  const outcome = evaluateTextScan(output, subject.declared, labels);
  const subjectMeta = metadata.subjectMeta ?? subject.meta;
  const extra = inputMeta(metadata, flaggedSegments);
  const meta = extra ? { ...subjectMeta, ...extra } : subjectMeta;
  const recorded = await recordTextScanSuccess({
    entityType: emEntityType,
    entityId,
    workflowId,
    marker,
    outcome,
    output,
    promptIds: metadata.promptIds ?? {},
    model: metadata.model ?? '',
    textHash: metadata.textHash,
    meta,
    modelRules,
  });
  if (!recorded) return log('warning', 'stale callback ignored', ctx);

  void logScanVerdict({
    system: 'text-scan',
    entityType,
    entityId,
    userId: subject.userId,
    mode,
    workflowId,
    flagged: outcome.triggeredLabels.length > 0,
    acted: submittedActive && outcome.triggeredLabels.length > 0,
    nsfwLevel: outcome.nsfw?.detectedLevel,
    declaredNsfwLevel: outcome.nsfw?.declaredLevel,
    poi: outcome.poi?.detected,
    minor: outcome.minor?.detected,
    scam: outcome.scam?.detected,
    csam: outcome.csam?.detected,
    tags: [
      ...outcome.triggeredLabels,
      ...(outcome.modelRules?.matched.map((m) => `modelRules:${m.ruleId}`) ?? []),
      ...(metadata.inputCut ? ['inputCut'] : []),
    ],
    textHash: metadata.textHash,
    ...(variant ? { variant } : {}),
  });

  try {
    await adapter?.applyTextScan?.({
      entityId,
      workflowId,
      outcome,
      subject,
      textHash: metadata.textHash ?? textScanTextHash(subject),
      promptIds: metadata.promptIds,
    });
  } catch (error) {
    // Left Succeeded, the row would never be retried and the verdict would be lost; Failed puts it
    // back in front of the retry cron, whose rescan acts on a fresh workflow.
    await recordTextScanFailure({
      entityType: emEntityType,
      entityId,
      workflowId,
      status: EntityModerationStatus.Failed,
    });
    await log('error', 'applying the verdict failed', {
      ...ctx,
      error: (error as Error).message,
    });
    throw error;
  }
}
