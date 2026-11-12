import * as z from 'zod';

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
  modelRef: z.string().min(1),
  checkpointSha256: z.string().min(1),
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
