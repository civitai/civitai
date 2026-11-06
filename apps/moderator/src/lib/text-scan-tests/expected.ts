import { z } from 'zod';
import {
  LAB_LABELS,
  NSFW_LEVEL_NAMES,
  type LabEntityType,
  type LabLabel,
  type NsfwLevelName,
} from '../text-scan-lab/types';

export const FLAG_LABELS = ['poi', 'minor', 'scam', 'csam'] as const;
export type FlagLabel = (typeof FLAG_LABELS)[number];

export type NsfwRange = { min: NsfwLevelName; max: NsfwLevelName };

export type Expected = {
  nsfw?: NsfwRange;
  poi?: boolean;
  minor?: boolean;
  scam?: boolean;
  csam?: boolean;
};

export const LABEL_ORDER: readonly LabLabel[] = ['nsfw', 'poi', 'minor', 'scam', 'csam'];
const MALFORMED = 'The expectation is malformed.';

export const levelRank = (level: NsfwLevelName) => NSFW_LEVEL_NAMES.indexOf(level);

const isLevel = (value: unknown): value is NsfwLevelName =>
  typeof value === 'string' && (NSFW_LEVEL_NAMES as readonly string[]).includes(value);

const level = z.enum(NSFW_LEVEL_NAMES, {
  error: `Use one of ${NSFW_LEVEL_NAMES.join(', ')}.`,
});

export const expectedSchema = z.object({
  nsfw: z
    .object({ min: level, max: level })
    .refine((r) => levelRank(r.min) <= levelRank(r.max), 'The lowest rating is above the highest.')
    .optional(),
  poi: z.boolean().optional(),
  minor: z.boolean().optional(),
  scam: z.boolean().optional(),
  csam: z.boolean().optional(),
});

export function parseExpected(json: unknown, entityType: LabEntityType): Expected | string {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return MALFORMED;
  const labels = LAB_LABELS[entityType];
  const outside = Object.keys(json).filter((key) => !(labels as readonly string[]).includes(key));
  if (outside.length)
    return `${entityType} cases score ${labels.join(', ')}, not ${outside.join(', ')}.`;
  const parsed = expectedSchema.safeParse(json);
  return parsed.success ? parsed.data : parsed.error.issues[0]?.message ?? MALFORMED;
}

export function expectedFromOutput(
  output: Record<string, unknown> | null,
  labels: readonly LabLabel[]
): Expected {
  const expected: Expected = {};
  for (const label of labels) {
    const verdict = output?.[label] as { level?: unknown; detected?: unknown } | undefined;
    if (!verdict || typeof verdict !== 'object') continue;
    if (label === 'nsfw') {
      if (isLevel(verdict.level)) expected.nsfw = { min: verdict.level, max: verdict.level };
    } else if (typeof verdict.detected === 'boolean') expected[label] = verdict.detected;
  }
  return expected;
}

export const scoredLabels = (expected: Expected): LabLabel[] =>
  LABEL_ORDER.filter((label) => expected[label] !== undefined);
