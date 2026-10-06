import { NSFW_LEVEL_NAMES, type Expected, type LabLabel, type NsfwLevelName } from './types';

export class InvalidExpectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExpectedError';
  }
}

const ALL_LABELS: readonly LabLabel[] = ['nsfw', 'poi', 'minor', 'scam'];
const FLAG_LABELS = ['poi', 'minor', 'scam'] as const;

const isLevel = (v: unknown): v is NsfwLevelName =>
  typeof v === 'string' && (NSFW_LEVEL_NAMES as readonly string[]).includes(v);
export const levelRank = (level: NsfwLevelName) => NSFW_LEVEL_NAMES.indexOf(level);

/** What a scan said, as an expectation: nsfw pinned to the level it gave, each flag to its verdict.
 *  A label without a usable verdict is left out, which means "don't score". */
export function expectedFromOutput(
  output: Record<string, unknown> | null,
  labels: readonly LabLabel[]
): Expected {
  const expected: Expected = {};
  if (!output) return expected;
  for (const label of labels) {
    const v = output[label] as { level?: unknown; detected?: unknown } | undefined;
    if (!v || typeof v !== 'object') continue;
    if (label === 'nsfw') {
      if (isLevel(v.level)) expected.nsfw = { min: v.level, max: v.level };
    } else if (typeof v.detected === 'boolean') {
      expected[label] = v.detected;
    }
  }
  return expected;
}

export function parseExpected(json: unknown, labels: readonly LabLabel[] = ALL_LABELS): Expected {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new InvalidExpectedError('Expected must be an object.');
  const raw = json as Record<string, unknown>;
  const outside = Object.keys(raw).filter((k) => !(labels as readonly string[]).includes(k));
  if (outside.length)
    throw new InvalidExpectedError(
      `Cannot expect ${outside.join(', ')} — this entity type scores ${labels.join(', ')}.`
    );

  const expected: Expected = {};
  if (raw.nsfw !== undefined) {
    const { min, max } = (raw.nsfw ?? {}) as { min?: unknown; max?: unknown };
    const bad = [min, max].filter((v) => !isLevel(v));
    if (bad.length)
      throw new InvalidExpectedError(
        `Unknown nsfw level ${bad.map(String).join(', ')} — use ${NSFW_LEVEL_NAMES.join(', ')}.`
      );
    const range = { min: min as NsfwLevelName, max: max as NsfwLevelName };
    if (levelRank(range.min) > levelRank(range.max))
      throw new InvalidExpectedError(`nsfw min ${range.min} is above max ${range.max}.`);
    expected.nsfw = range;
  }
  for (const label of FLAG_LABELS) {
    if (raw[label] === undefined) continue;
    if (typeof raw[label] !== 'boolean')
      throw new InvalidExpectedError(`${label} must be yes or no, or left unscored.`);
    expected[label] = raw[label];
  }
  return expected;
}

export function describeExpected(expected: Expected): string[] {
  const chips: string[] = [];
  if (expected.nsfw) {
    const { min, max } = expected.nsfw;
    chips.push(`nsfw ${min === max ? min : `${min}–${max}`}`);
  }
  for (const label of FLAG_LABELS)
    if (expected[label] !== undefined) chips.push(`${label} ${expected[label] ? 'yes' : 'no'}`);
  return chips;
}
