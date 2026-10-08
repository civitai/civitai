import * as z from 'zod';
import type { TextScanLabel, TextScanOutput } from '~/server/services/text-scan/types';
import { NSFW_LEVEL_NAMES } from '~/server/services/text-scan/types';

export type TextScanFailureReason =
  | 'empty'
  | 'refused'
  | 'truncated'
  | 'malformed'
  | 'missing_label';

export type TextScanParseResult =
  | { ok: true; output: TextScanOutput }
  | { ok: false; reason: TextScanFailureReason; detail?: string };

export type ChatCompletionStepLike = {
  $type?: string;
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
};

export function findChatCompletionStep(steps: unknown): ChatCompletionStepLike | undefined {
  if (!Array.isArray(steps)) return undefined;
  return (steps as ChatCompletionStepLike[]).find((s) => s?.$type === 'chatCompletion');
}

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
