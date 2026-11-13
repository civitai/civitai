import { submitWorkflow } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { mergeTextScanOutputs } from '~/server/services/text-scan/merge';
import {
  parseTextScanStep,
  parseTextScanSteps,
  textScanStepsBySegment,
} from '~/server/services/text-scan/parse';
import { logToAxiom } from '~/server/logging/client';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
  MissingTextScanPromptError,
} from '~/server/services/text-scan/prompt';
import { buildTextScanStep, buildTextScanSteps } from '~/server/services/text-scan/submit';
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

export type TextScanEachVerdict =
  | { status: 'ok'; output: TextScanOutput }
  /** The step as a whole did not parse; `output` holds the labels that did on their own. */
  | { status: 'partial'; output: TextScanOutput }
  | { status: 'refused' }
  /** Too long for one step, so it cannot be rated on its own. */
  | { status: 'too-long' }
  | { status: 'unavailable' };

/**
 * {@link previewTextScanLabel} for each field on its own: one step per field in one workflow, each
 * read by itself, so one unusable step leaves only its own field without a verdict. Writes nothing.
 */
export async function previewTextScanEach({
  labels,
  fields,
  waitSeconds,
}: {
  labels: TextScanLabel[];
  fields: TextScanField[];
  waitSeconds: number;
}): Promise<{ workflowId: string | null; verdicts: TextScanEachVerdict[] }> {
  const unavailable = () => ({
    workflowId: null,
    verdicts: fields.map((): TextScanEachVerdict => ({ status: 'unavailable' })),
  });
  if (!fields.length) return { workflowId: null, verdicts: [] };
  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);

  const segmentOf = new Map<number, number>();
  const steps: ReturnType<typeof buildTextScanStep>[] = [];
  try {
    fields.forEach((field, index) => {
      const composed = composeTextScanMessages({
        prompts,
        labels,
        subject: { fields: [field], declared: {} },
        maxInputChars: config.maxInputChars,
        maxSegments: config.maxSegments,
      });
      if (composed.segments.length !== 1) return;
      segmentOf.set(index, steps.length);
      steps.push(
        buildTextScanStep({
          system: composed.system,
          user: composed.segments[0],
          model: config.model,
          labels,
          thinking: config.thinking,
          segment: steps.length,
        })
      );
    });
  } catch (error) {
    if (!(error instanceof MissingTextScanPromptError)) throw error;
    logToAxiom({
      type: 'error',
      name: 'text-scan-prompt-missing',
      message: `${labels.join(',')} prompt missing`,
      keys: error.keys,
    });
    return unavailable();
  }
  const tooLong = () => ({
    workflowId: null,
    verdicts: fields.map(
      (_, index): TextScanEachVerdict =>
        segmentOf.has(index) ? { status: 'unavailable' } : { status: 'too-long' }
    ),
  });
  if (!steps.length) return tooLong();

  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: waitSeconds },
    body: { metadata: { purpose: 'text-scan-preview' }, currencies: [], steps },
  });
  if (!data) return tooLong();

  const bySegment = textScanStepsBySegment(data.steps);
  const verdicts = fields.map((_, index): TextScanEachVerdict => {
    const segment = segmentOf.get(index);
    if (segment === undefined) return { status: 'too-long' };
    const step = bySegment.get(segment);
    if (!step || (step.status && step.status !== 'succeeded')) return { status: 'unavailable' };
    const parsed = parseTextScanStep(step, labels);
    if (parsed.ok) return { status: 'ok', output: parsed.output };
    if (parsed.reason === 'refused') return { status: 'refused' };
    // One malformed label must not discard the others, a detection above all.
    const output: TextScanOutput = {};
    for (const label of labels) {
      const one = parseTextScanStep(step, [label]);
      if (one.ok) Object.assign(output, one.output);
    }
    return Object.keys(output).length ? { status: 'partial', output } : { status: 'unavailable' };
  });
  return { workflowId: data.id ?? null, verdicts };
}
