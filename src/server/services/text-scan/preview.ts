import { submitWorkflow } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { mergeTextScanOutputs } from '~/server/services/text-scan/merge';
import { parseTextScanSteps } from '~/server/services/text-scan/parse';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
} from '~/server/services/text-scan/prompt';
import { buildTextScanSteps } from '~/server/services/text-scan/submit';
import type { NsfwLevel } from '~/server/common/enums';
import type { TextScanField, TextScanLabel } from '~/server/services/text-scan/types';
import { nsfwLevelFromName } from '~/server/services/text-scan/types';

const PREVIEW_LABELS: TextScanLabel[] = ['nsfw'];

export type TextScanNsfwPreview =
  | { status: 'ok'; level: NsfwLevel; reason: string }
  | { status: 'unavailable' };

/**
 * The text-scan's nsfw verdict on text that is not stored yet, with production's prompts, model and
 * config: the same classifier that sets a model's `nsfw` flag. It registers no callback and names
 * no entity, so it writes no moderation record and acts on nothing.
 */
export async function previewTextScanNsfw({
  fields,
  waitSeconds,
}: {
  fields: TextScanField[];
  waitSeconds: number;
}): Promise<TextScanNsfwPreview> {
  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  const composed = composeTextScanMessages({
    prompts,
    labels: PREVIEW_LABELS,
    subject: { fields, declared: {} },
    maxInputChars: config.maxInputChars,
    maxSegments: config.maxSegments,
  });
  const steps = buildTextScanSteps({
    system: composed.system,
    segments: composed.segments,
    model: config.model,
    labels: PREVIEW_LABELS,
    thinking: config.thinking,
  });

  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: waitSeconds },
    body: { metadata: { purpose: 'text-scan-preview' }, currencies: [], steps },
  });
  if (data?.status !== 'succeeded') return { status: 'unavailable' };

  const parsed = parseTextScanSteps(data.steps, PREVIEW_LABELS, steps.length);
  if (!parsed.ok) return { status: 'unavailable' };
  const nsfw = mergeTextScanOutputs(parsed.outputs, PREVIEW_LABELS).output.nsfw;
  if (!nsfw) return { status: 'unavailable' };
  return { status: 'ok', level: nsfwLevelFromName[nsfw.level], reason: nsfw.reason };
}
