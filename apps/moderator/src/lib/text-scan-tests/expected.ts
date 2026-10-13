import { z } from 'zod';
import {
  LAB_LABELS,
  NSFW_LEVEL_NAMES,
  type LabEntityType,
  type LabLabel,
  type NsfwLevelName,
} from '../text-scan-lab/types';

export const FLAG_LABELS = ['poi', 'minor', 'scam'] as const;
export type FlagLabel = (typeof FLAG_LABELS)[number];

export type NsfwRange = { min: NsfwLevelName; max: NsfwLevelName };

export type Expected = {
  nsfw?: NsfwRange;
  poi?: boolean;
  minor?: boolean;
  scam?: boolean;
  modelRules?: { ruleIds: number[] };
};

export const LABEL_ORDER: readonly LabLabel[] = ['nsfw', 'poi', 'minor', 'scam', 'modelRules'];
export const MAX_EXPECTED_RULES = 200;
const MALFORMED = 'The expectation is malformed.';

export const levelRank = (level: NsfwLevelName) => NSFW_LEVEL_NAMES.indexOf(level);

const isLevel = (value: unknown): value is NsfwLevelName =>
  typeof value === 'string' && (NSFW_LEVEL_NAMES as readonly string[]).includes(value);

const level = z.enum(NSFW_LEVEL_NAMES, {
  error: `Use one of ${NSFW_LEVEL_NAMES.join(', ')}.`,
});

const sortedUnique = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

export const expectedSchema = z.object({
  nsfw: z
    .object({ min: level, max: level })
    .refine((r) => levelRank(r.min) <= levelRank(r.max), 'The lowest rating is above the highest.')
    .optional(),
  poi: z.boolean().optional(),
  minor: z.boolean().optional(),
  scam: z.boolean().optional(),
  modelRules: z
    .object({
      ruleIds: z
        .array(z.number().int().positive('Only saved rules can be expected.'))
        .max(MAX_EXPECTED_RULES, `At most ${MAX_EXPECTED_RULES} rules.`)
        .transform(sortedUnique),
    })
    .optional(),
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
  labels: readonly LabLabel[],
  matchedRuleIds: readonly number[] | null
): Expected {
  const expected: Expected = {};
  for (const label of labels) {
    if (label === 'modelRules') {
      if (matchedRuleIds)
        expected.modelRules = { ruleIds: sortedUnique(matchedRuleIds.filter((id) => id > 0)) };
      continue;
    }
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
