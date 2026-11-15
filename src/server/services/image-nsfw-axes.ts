import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';

/** An image's rating axes from one rater checkpoint. Levels are 0-4. */
export type RatingAxes = {
  sexual: number;
  violence: number;
  rater: string;
  raterVersion: string;
};

const axisLevel = (prefix: 'S' | 'V') =>
  z
    .object({ label: z.string().regex(new RegExp(`^${prefix}[0-4]$`)) })
    .transform(({ label }) => Number(label.slice(1)));

// Only what is stored is read; the rest of the rater's output is not ours to keep.
const ratingV2Schema = z.object({
  status: z.literal('ok'),
  modelRef: z.string().min(1).max(200),
  checkpointSha256: z.string().min(1).max(200),
  sexual: axisLevel('S'),
  violence: axisLevel('V'),
});

/** The axes in an imageScanning step's `ratingV2`; undefined when absent, failed or malformed, never S0. */
export function readRatingAxes(ratingV2: unknown): RatingAxes | undefined {
  const parsed = ratingV2Schema.safeParse(ratingV2);
  if (!parsed.success) return undefined;
  const { modelRef, checkpointSha256, sexual, violence } = parsed.data;
  return { sexual, violence, rater: modelRef, raterVersion: checkpointSha256 };
}

/** A video's axes: the highest per axis, and none unless every frame was rated by one checkpoint. */
export function combineFrameAxes(frames: (RatingAxes | undefined)[]): RatingAxes | undefined {
  const rated = frames.filter((frame): frame is RatingAxes => !!frame);
  const [first] = rated;
  if (!first || rated.length !== frames.length) return undefined;
  if (rated.some((f) => f.rater !== first.rater || f.raterVersion !== first.raterVersion))
    return undefined;
  return {
    ...first,
    sexual: Math.max(...rated.map((f) => f.sexual)),
    violence: Math.max(...rated.map((f) => f.violence)),
  };
}

// `Image.nsfwAxes`: one integer, one-hot per group, so a group with a value has exactly one bit set
// and an empty group has none. NULL: not rated by an axis-capable rater.
const GROUPS = {
  sexual: { offset: 0, size: 5 },
  violence: { offset: 5, size: 5 },
  language: { offset: 10, size: 3 },
  sexualHighWater: { offset: 13, size: 5 },
} as const;
type Group = keyof typeof GROUPS;
/** Bit 18: set by a moderator. Covers the whole value: a scan changes no group of it. */
export const MODERATOR_BIT = 1 << 18;

export type NsfwAxes = Record<Group, number | null> & { moderator: boolean };

export function packNsfwAxes(axes: NsfwAxes): number {
  let value = axes.moderator ? MODERATOR_BIT : 0;
  for (const [group, { offset, size }] of Object.entries(GROUPS)) {
    const level = axes[group as Group];
    if (level === null) continue;
    if (!Number.isInteger(level) || level < 0 || level >= size)
      throw new Error(`${group} level out of range: ${level}`);
    value |= 1 << (offset + level);
  }
  return value;
}

export function unpackNsfwAxes(value: number | null): NsfwAxes | null {
  if (value === null) return null;
  const axes = { moderator: (value & MODERATOR_BIT) !== 0 } as NsfwAxes;
  for (const [group, { offset, size }] of Object.entries(GROUPS)) {
    const bits = (value >> offset) & ((1 << size) - 1);
    if (bits & (bits - 1)) throw new Error(`${group} has more than one bit set: ${value}`);
    axes[group as Group] = bits ? Math.log2(bits) : null;
  }
  return axes;
}

const { offset: HW, size: HW_SIZE } = GROUPS.sexualHighWater;
// The stored high-water level, or NULL when unset. Built from constants only.
const storedHighWater = Prisma.raw(
  `CASE ${Array.from({ length: HW_SIZE }, (_, i) => HW_SIZE - 1 - i)
    .map((level) => `WHEN "nsfwAxes" & ${1 << (HW + level)} <> 0 THEN ${level}`)
    .join(' ')} END`
);

/**
 * The `"nsfwAxes"` SET term for a scan's verdict UPDATE on "Image"; Prisma.empty while the flag is
 * off, so the verdict SQL is then exactly what it is without axes.
 * Order of the rules, outermost first:
 *  1. A moderator value (bit 18) is kept whole: no axis of it, high-water included, changes.
 *  2. Only the workflow the row was last submitted for writes. SET reads the pre-update row, so
 *     this sees "scanJobs" before the same statement re-stamps it; an older result arriving last,
 *     or a row with no workflowId, keeps its value.
 *  3. The sexual high-water takes the greater of the stored one and the new sexual level.
 */
export async function nsfwAxesScanSet({
  imageId,
  axes,
  workflowId,
}: {
  imageId: number;
  axes?: RatingAxes;
  workflowId: string;
}): Promise<Prisma.Sql> {
  if (!axes) return Prisma.empty;
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.IMAGE_AXIS_SHADOW_WRITE, String(imageId))))
      return Prisma.empty;
    const rated = packNsfwAxes({
      sexual: axes.sexual,
      violence: axes.violence,
      language: null,
      sexualHighWater: null,
      moderator: false,
    });
    return Prisma.sql`,
      "nsfwAxes" = CASE
        WHEN "nsfwAxes" & ${Prisma.raw(String(MODERATOR_BIT))} <> 0 THEN "nsfwAxes"
        WHEN "scanJobs"->>'workflowId' = ${workflowId}
          THEN ${rated}::int | (1 << (${Prisma.raw(String(HW))} + GREATEST(${
      axes.sexual
    }::int, ${storedHighWater})))
        ELSE "nsfwAxes"
      END`;
  } catch (error) {
    logAxesFailure(imageId, workflowId, error);
    return Prisma.empty;
  }
}

/** The verdict UPDATE failed only because "nsfwAxes" does not exist yet (its migration is unapplied). */
export function isNsfwAxesMissing(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const message = typeof e?.message === 'string' ? e.message : '';
  if (!message.includes('nsfwAxes')) return false;
  return (
    e.code === '42703' ||
    e.meta?.code === '42703' ||
    /\b42703\b/.test(message) ||
    /column "nsfwAxes".* does not exist/.test(message)
  );
}

/**
 * Runs a verdict write with its axes term. If the column is missing, it logs and writes the verdict
 * without the term, so the axes never fail a scan. Any other error propagates as it would without axes.
 */
export async function writeWithNsfwAxes(
  write: (axesSet: Prisma.Sql) => Promise<unknown>,
  axesSet: Prisma.Sql,
  { imageId, workflowId }: { imageId: number; workflowId: string }
) {
  try {
    await write(axesSet);
  } catch (error) {
    if (axesSet === Prisma.empty || !isNsfwAxesMissing(error)) throw error;
    logAxesFailure(imageId, workflowId, error);
    await write(Prisma.empty);
  }
}

function logAxesFailure(imageId: number, workflowId: string, error: unknown) {
  logToAxiom(
    {
      name: 'image-nsfw-axes',
      type: 'error',
      message: 'rating axes not stored',
      reason: error instanceof Error ? error.message : 'Unknown error',
      imageId,
      workflowId,
    },
    'webhooks'
  ).catch(() => null);
}
