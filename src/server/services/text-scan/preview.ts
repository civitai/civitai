import { submitWorkflow } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { mergeTextScanOutputs } from '~/server/services/text-scan/merge';
import { parseTextScanSteps } from '~/server/services/text-scan/parse';
import { logToAxiom } from '~/server/logging/client';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
  MissingTextScanPromptError,
} from '~/server/services/text-scan/prompt';
import { buildTextScanSteps } from '~/server/services/text-scan/submit';
import type { NsfwLevel } from '~/server/common/enums';
import type {
  TextScanField,
  TextScanLabel,
  TextScanOutput,
} from '~/server/services/text-scan/types';
import { nsfwLevelFromName } from '~/server/services/text-scan/types';

export type TextScanNsfwPreview =
  | { status: 'ok'; level: NsfwLevel; reason: string }
  | { status: 'unavailable' };

/**
 * The text-scan's verdict for `label` on text that is not stored yet, with production's prompts,
 * model and config. It registers no callback and names no entity, so it writes no moderation record
 * and acts on nothing. A label with no prompt row is logged as missing and comes back unavailable.
 */
async function previewTextScanLabel<L extends TextScanLabel>({
  label,
  fields,
  waitSeconds,
}: {
  label: L;
  fields: TextScanField[];
  waitSeconds: number;
}): Promise<{ status: 'ok'; output: NonNullable<TextScanOutput[L]> } | { status: 'unavailable' }> {
  const labels = [label];
  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  let composed: ReturnType<typeof composeTextScanMessages>;
  try {
    composed = composeTextScanMessages({
      prompts,
      labels,
      subject: { fields, declared: {} },
      maxInputChars: config.maxInputChars,
      maxSegments: config.maxSegments,
    });
  } catch (error) {
    if (!(error instanceof MissingTextScanPromptError)) throw error;
    logToAxiom({
      type: 'error',
      name: 'text-scan-prompt-missing',
      message: `${label} prompt missing`,
      keys: error.keys,
    });
    return { status: 'unavailable' };
  }
  const steps = buildTextScanSteps({
    system: composed.system,
    segments: composed.segments,
    model: config.model,
    labels,
    thinking: config.thinking,
  });

  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: waitSeconds },
    body: { metadata: { purpose: 'text-scan-preview' }, currencies: [], steps },
  });
  if (data?.status !== 'succeeded') return { status: 'unavailable' };

  const parsed = parseTextScanSteps(data.steps, labels, steps.length);
  if (!parsed.ok) return { status: 'unavailable' };
  const output = mergeTextScanOutputs(parsed.outputs, labels).output[label];
  if (!output) return { status: 'unavailable' };
  return { status: 'ok', output: output as NonNullable<TextScanOutput[L]> };
}

/** The nsfw verdict: the same classifier that sets a model's `nsfw` flag. */
export async function previewTextScanNsfw(args: {
  fields: TextScanField[];
  waitSeconds: number;
}): Promise<TextScanNsfwPreview> {
  const result = await previewTextScanLabel({ label: 'nsfw', ...args });
  if (result.status !== 'ok') return result;
  return {
    status: 'ok',
    level: nsfwLevelFromName[result.output.level],
    reason: result.output.reason,
  };
}

/** Whether a model's listing is something a civitai.com face may be built for. */
export async function previewComFaceIntent(args: { fields: TextScanField[]; waitSeconds: number }) {
  return previewTextScanLabel({ label: 'model-com-face-intent', ...args });
}
