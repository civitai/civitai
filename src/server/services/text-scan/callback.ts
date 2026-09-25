import { getWorkflow } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import { getTextScanMode, textScanEmEntityType } from '~/server/services/text-scan/mode';
import { findChatCompletionStep, parseTextScanStep } from '~/server/services/text-scan/parse';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import { recordTextScanFailure, recordTextScanSuccess } from '~/server/services/text-scan/record';
import type { PromptIds, TextScanLabel } from '~/server/services/text-scan/types';
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
    externalId?: string;
    labels?: TextScanLabel[];
    promptIds?: PromptIds;
    model?: string;
    textHash?: string;
    subjectMeta?: Record<string, unknown>;
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
  const emEntityType = textScanEmEntityType(entityType, mode);
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
  if (submittedActive && (await getTextScanMode(entityType, entityId)) !== 'active')
    return log('info', 'mode left active before the callback; live row not written', ctx);

  // Shadow verdicts must not drive the live adapter's failure hooks either (e.g. Article ingestion).
  const adapter = submittedActive ? getModerationAdapter(entityType) : undefined;

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
    await adapter?.applyFailure?.({ entityId, workflowId, status });
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
    await adapter?.applyFailure?.({ entityId, workflowId, status: 'failed' });
    return;
  }

  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return log('info', 'entity gone before callback', ctx);

  const outcome = evaluateTextScan(parsed.output, subject.declared, labels);
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
    meta: metadata.subjectMeta ?? subject.meta,
  });
  if (!recorded) return log('warning', 'stale callback ignored', ctx);

  await adapter?.applyTextScan?.({ entityId, workflowId, outcome, subject });
}
