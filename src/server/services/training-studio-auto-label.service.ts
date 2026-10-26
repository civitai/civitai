import type {
  AudioCaptioningStepTemplate,
  MediaCaptioningStepTemplate,
  WdTaggingStepTemplate,
  WorkflowStepTemplate,
} from '@civitai/orchestration-client';
import {
  getWorkflow as clientGetWorkflow,
  submitWorkflow as clientSubmitWorkflow,
} from '@civitai/orchestration-client';
import type {
  StudioAutoLabelPollInput,
  StudioAutoLabelSubmitInput,
} from '~/server/schema/training-studio-auto-label.schema';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { assertSafeMediaUrls, toOrchestratorError } from '~/server/services/training.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * The Training Studio's auto-label, run on the system token: it is free to the user, and a workflow
 * submitted with the user's own token is charged to them (empty `currencies` = any account). The
 * step shapes and the poll result mirror apps/training-studio/src/lib/autolabel-core.ts, which the
 * element hands these to through its host. Polls are scoped to the submitting user via metadata,
 * since the system token can read every workflow.
 */

const WD_THRESHOLD = 0.35;
const CAPTION_MAX_TOKENS = 300;
const CAPTION_TEMPERATURE = 0.7;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

type StudioAutoLabelMetadata = { kind: 'studio-auto-label'; userId: number };

export type StudioAutoLabelResult = {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
};

export async function submitStudioAutoLabel({
  userId,
  mode,
  media,
  items,
}: StudioAutoLabelSubmitInput & { userId: number }) {
  assertSafeMediaUrls(items.map((i) => i.mediaUrl));

  const steps: WorkflowStepTemplate[] = items.map((item, i) => {
    const metadata = { key: item.key };
    if (mode === 'tag') {
      const step: WdTaggingStepTemplate = {
        $type: 'wdTagging',
        name: `${i}`,
        input: { mediaUrl: item.mediaUrl, threshold: WD_THRESHOLD },
        metadata,
      };
      return step;
    }
    if (media === 'audio') {
      const step: AudioCaptioningStepTemplate = {
        $type: 'audioCaptioning',
        name: `${i}`,
        input: {
          mediaUrl: item.mediaUrl,
          temperature: CAPTION_TEMPERATURE,
          maxNewTokens: CAPTION_MAX_TOKENS,
          includeCaption: true,
          prepareForModeration: false,
        },
        metadata,
      };
      return step;
    }
    const step: MediaCaptioningStepTemplate = {
      $type: 'mediaCaptioning',
      name: `${i}`,
      input: { mediaUrl: item.mediaUrl, maxNewTokens: CAPTION_MAX_TOKENS },
      metadata,
    };
    return step;
  });

  const metadata: StudioAutoLabelMetadata = { kind: 'studio-auto-label', userId };
  const { data, error } = await clientSubmitWorkflow({
    client: internalOrchestratorClient,
    body: { tags: ['civitai', 'training-studio', 'auto-label'], metadata, steps, currencies: [] },
    query: { wait: 0 },
  });
  if (!data) toOrchestratorError(error);
  if (!data.id) throw throwBadRequestError('Workflow submission returned no ID');
  return { workflowId: data.id };
}

export async function pollStudioAutoLabel({
  userId,
  workflowId,
}: StudioAutoLabelPollInput & { userId: number }): Promise<{
  done: boolean;
  results: StudioAutoLabelResult[];
}> {
  const { data, error } = await clientGetWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) toOrchestratorError(error);

  const metadata = data.metadata as Partial<StudioAutoLabelMetadata> | undefined;
  // Another user's workflow, or one that isn't a Studio auto-label, reads as missing.
  if (metadata?.kind !== 'studio-auto-label' || metadata.userId !== userId)
    throw throwNotFoundError('Workflow not found');

  const results = (data.steps ?? []).map((raw): StudioAutoLabelResult => {
    const step = raw as {
      status: string;
      metadata?: { key?: string };
      output?: {
        tags?: Record<string, number>;
        caption?: string | null;
        results?: Record<string, { caption?: string | null; text?: string | null }>;
      };
    };
    const key = step.metadata?.key ?? '';
    if (step.status === 'succeeded') {
      const out = step.output;
      if (out?.tags)
        return {
          key,
          status: 'succeeded',
          tags: Object.entries(out.tags)
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag),
        };
      if (out?.caption != null) return { key, status: 'succeeded', caption: out.caption };
      if (out?.results) {
        const first = Object.values(out.results)[0];
        return { key, status: 'succeeded', caption: first?.text ?? first?.caption ?? '' };
      }
      return { key, status: 'succeeded' };
    }
    if (TERMINAL_STATUSES.has(step.status)) return { key, status: 'failed' };
    return { key, status: 'pending' };
  });

  return { done: TERMINAL_STATUSES.has(data.status ?? ''), results };
}
