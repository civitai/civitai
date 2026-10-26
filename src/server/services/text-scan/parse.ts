import * as z from 'zod';
import type { TextScanLabel, TextScanOutput } from '~/server/services/text-scan/types';
import { NSFW_LEVEL_NAMES } from '~/server/services/text-scan/types';

export type TextScanFailureReason =
  | 'empty'
  | 'refused'
  | 'truncated'
  | 'malformed'
  | 'missing_label'
  | 'missing_segment';

export type TextScanParseResult =
  | { ok: true; output: TextScanOutput }
  | { ok: false; reason: TextScanFailureReason; detail?: string };

export type ChatCompletionStepLike = {
  $type?: string;
  name?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
  output?: {
    choices?: Array<{
      message?: { content?: string | null };
      finishReason?: string | null;
      finish_reason?: string | null;
    }>;
    parsed?: unknown;
  } | null;
};

const REFUSAL_CUES = [
  "i can't",
  'i cannot',
  "i won't",
  'i will not',
  'i am unable',
  "i'm unable",
  "i'm sorry",
  'i am sorry',
  'i apologize',
  'as an ai',
];

const labelValidators: Record<TextScanLabel, z.ZodType> = {
  nsfw: z.object({ level: z.enum(NSFW_LEVEL_NAMES), reason: z.string() }),
  poi: z.object({ detected: z.boolean(), names: z.array(z.string()), reason: z.string() }),
  minor: z.object({ detected: z.boolean(), reason: z.string() }),
  scam: z.object({ detected: z.boolean(), reason: z.string() }),
  csam: z.object({ detected: z.boolean(), reason: z.string() }),
};

function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content.trim());
  } catch {
    return undefined;
  }
}

export function parseTextScanStep(
  step: ChatCompletionStepLike | undefined,
  labels: TextScanLabel[]
): TextScanParseResult {
  const choice = step?.output?.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finishReason = choice?.finishReason ?? choice?.finish_reason ?? null;
  const parsed = step?.output?.parsed;

  if (finishReason === 'content_filter') return { ok: false, reason: 'refused' };
  if (parsed == null && !content.trim()) return { ok: false, reason: 'empty' };
  if (finishReason === 'length') return { ok: false, reason: 'truncated' };

  const json = parsed ?? tryParseJson(content);
  if (json === undefined) {
    const lower = content.toLowerCase();
    if (REFUSAL_CUES.some((cue) => lower.includes(cue))) return { ok: false, reason: 'refused' };
    return { ok: false, reason: 'malformed' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'malformed' };
  }

  const record = json as Record<string, unknown>;
  const missing = labels.filter((label) => record[label] == null);
  if (missing.length) return { ok: false, reason: 'missing_label', detail: missing.join(',') };

  const output: TextScanOutput = {};
  for (const label of labels) {
    const result = labelValidators[label].safeParse(record[label]);
    if (!result.success) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${label}: ${result.error.issues[0]?.message}`,
      };
    }
    (output as Record<string, unknown>)[label] = result.data;
  }
  return { ok: true, output };
}

const STEP_NAME = /^textScan(\d*)$/;

export function segmentIndexOf(step: ChatCompletionStepLike): number | undefined {
  const fromMetadata = step.metadata?.segment;
  if (Number.isInteger(fromMetadata) && (fromMetadata as number) >= 0)
    return fromMetadata as number;
  const match = STEP_NAME.exec(step.name ?? '');
  if (match) return match[1] ? Number(match[1]) : 0;
  return undefined;
}

function chatCompletionSteps(steps: unknown): ChatCompletionStepLike[] {
  if (!Array.isArray(steps)) return [];
  return (steps as ChatCompletionStepLike[]).filter((s) => s?.$type === 'chatCompletion');
}

/** First step wins when two share a segment. */
export function textScanStepsBySegment(steps: unknown) {
  const bySegment = new Map<number, ChatCompletionStepLike>();
  chatCompletionSteps(steps).forEach((step, order) => {
    const segment = segmentIndexOf(step) ?? order;
    if (!bySegment.has(segment)) bySegment.set(segment, step);
  });
  return bySegment;
}

export type TextScanStepsResult =
  | { ok: true; outputs: TextScanOutput[] }
  | {
      ok: false;
      reason: TextScanFailureReason;
      detail?: string;
      segment?: number;
      /** The segments that did parse, in segment order; empty when the workflow itself is unusable. */
      outputs: TextScanOutput[];
    };

/**
 * All `expected` segments parsed, in segment order, or the first failure with its segment. Any
 * missing, extra or unusable step fails the scan: a partial verdict must never replace the stored
 * one, though the callback may still raise it from the segments that parsed.
 */
export function parseTextScanSteps(
  steps: unknown,
  labels: TextScanLabel[],
  expected: number
): TextScanStepsResult {
  if (!Number.isInteger(expected) || expected < 1)
    return {
      ok: false,
      reason: 'malformed',
      detail: `invalid expected step count ${expected}`,
      outputs: [],
    };
  const count = chatCompletionSteps(steps).length;
  if (count > expected)
    return {
      ok: false,
      reason: 'malformed',
      detail: `expected ${expected} chatCompletion steps, got ${count}`,
      outputs: [],
    };
  const bySegment = textScanStepsBySegment(steps);
  const outputs: TextScanOutput[] = [];
  let failure: { reason: TextScanFailureReason; detail?: string; segment: number } | undefined;
  for (let segment = 0; segment < expected; segment++) {
    const step = bySegment.get(segment);
    const parsed: TextScanParseResult = step
      ? parseTextScanStep(step, labels)
      : { ok: false, reason: 'missing_segment' };
    if (parsed.ok) outputs.push(parsed.output);
    else failure ??= { reason: parsed.reason, detail: parsed.detail, segment };
  }
  if (!failure) return { ok: true, outputs };
  const { detail, ...rest } = failure;
  return { ok: false, ...rest, ...(detail === undefined ? {} : { detail }), outputs };
}
