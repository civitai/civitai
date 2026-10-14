import { getWorkflow } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import {
  getTextScanMode,
  getTextScanWebSearchMode,
  isTextScanWebSearchEntityType,
  TEXT_SCAN_WEB_SEARCH_LABELS,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { findChatCompletionStep, parseTextScanStep } from '~/server/services/text-scan/parse';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  filterModelRuleMatches,
  getModelRuleSnapshots,
} from '~/server/services/text-scan/model-rules';
import {
  recordTextScanFailure,
  recordTextScanSuccess,
  type TextScanResult,
} from '~/server/services/text-scan/record';
import type { PromptIds, TextScanLabel } from '~/server/services/text-scan/types';
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

export async function handleTextScanCallback(event: { workflowId: string; status: string }) {
  const { workflowId } = event;
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${workflowId}`);

  const metadata = (data.metadata ?? {}) as {
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
  };
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

  // After a rollback the old pipeline owns the live row again, and plan 02's floor reads it.
  const currentMode = variant
    ? await getTextScanWebSearchMode(entityType, entityId)
    : await getTextScanMode(entityType, entityId);
  if (submittedActive && currentMode !== 'active')
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

  const parsed = parseTextScanStep(findChatCompletionStep(data.steps), labels);
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
    });
    await failureAdapter?.applyFailure?.({ entityId, workflowId, status: 'failed' });
    return;
  }

  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return log('info', 'entity gone before callback', ctx);

  let modelRules: TextScanResult['modelRules'];
  if (parsed.output.modelRules) {
    const { kept, dropped } = filterModelRuleMatches(
      parsed.output.modelRules.matched,
      metadata.ruleIds
    );
    if (dropped.length)
      await log('warning', 'matched rule ids the prompt did not list', { ...ctx, dropped });
    const listed = new Set(metadata.ruleIds);
    const literalCandidates = (metadata.literalRuleIds ?? []).filter((id) => listed.has(id));
    const snapshot = await getModelRuleSnapshots([
      ...new Set([...kept.map((m) => m.ruleId), ...literalCandidates]),
    ]);
    const live = new Set(snapshot.map((rule) => rule.id));
    parsed.output.modelRules = { matched: kept.filter((m) => live.has(m.ruleId)) };
    modelRules = {
      fingerprint: metadata.rulesFingerprint,
      snapshot,
      literalRuleIds: literalCandidates.filter((id) => live.has(id)),
    };
  }

  const outcome = evaluateTextScan(parsed.output, subject.declared, labels);
  const subjectMeta = metadata.subjectMeta ?? subject.meta;
  const meta =
    metadata.inputChars === undefined
      ? subjectMeta
      : { ...subjectMeta, inputChars: metadata.inputChars, inputCut: metadata.inputCut ?? false };
  const recorded = await recordTextScanSuccess({
    entityType: emEntityType,
    entityId,
    workflowId,
    marker,
    outcome,
    output: parsed.output,
    promptIds: metadata.promptIds ?? {},
    model: metadata.model ?? '',
    textHash: metadata.textHash,
    meta,
    modelRules,
  });
  if (!recorded) return log('warning', 'stale callback ignored', ctx);

  // An active search pass owns poi/minor: a main pass submitted before it went active still asked
  // for them, and must not act on them now.
  const searchOwned = (label: TextScanLabel) =>
    (TEXT_SCAN_WEB_SEARCH_LABELS as readonly TextScanLabel[]).includes(label);
  const applied =
    submittedActive &&
    !variant &&
    labels.some(searchOwned) &&
    (await getTextScanWebSearchMode(entityType, entityId, 'active')) === 'active'
      ? evaluateTextScan(
          parsed.output,
          subject.declared,
          labels.filter((label) => !searchOwned(label))
        )
      : outcome;

  void logScanVerdict({
    system: 'text-scan',
    entityType,
    entityId,
    userId: subject.userId,
    mode,
    workflowId,
    flagged: outcome.triggeredLabels.length > 0,
    acted: submittedActive && applied.triggeredLabels.length > 0,
    nsfwLevel: outcome.nsfw?.detectedLevel,
    declaredNsfwLevel: outcome.nsfw?.declaredLevel,
    poi: outcome.poi?.detected,
    minor: outcome.minor?.detected,
    scam: outcome.scam?.detected,
    tags: [
      ...outcome.triggeredLabels,
      ...(outcome.modelRules?.matched.map((m) => `modelRules:${m.ruleId}`) ?? []),
    ],
    textHash: metadata.textHash,
    ...(variant ? { variant } : {}),
  });

  try {
    await adapter?.applyTextScan?.({
      entityId,
      workflowId,
      outcome: applied,
      subject,
      textHash: metadata.textHash ?? textScanTextHash(subject),
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
