import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
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

/**
 * Stores a scan's axes. A moderator row is never overwritten, and an older workflow never replaces
 * a newer one's levels, so a redelivered webhook is a no-op. The sexual high-water only rises here,
 * and does so even for a late, older result.
 * Never throws: this is a shadow write and must not fail the scan.
 */
export async function writeRatedAxes({
  imageId,
  axes,
  workflowId,
  completedAt,
}: {
  imageId: number;
  axes: RatingAxes;
  workflowId: string;
  completedAt?: Date | string | null;
}) {
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.IMAGE_AXIS_SHADOW_WRITE, String(imageId)))) return;
    // The completion time orders results; without it a late older result could replace a newer one.
    if (!completedAt) throw new Error('workflow has no completedAt');
    const ratedAt = new Date(completedAt);
    if (Number.isNaN(ratedAt.getTime())) throw new Error(`invalid completedAt: ${completedAt}`);

    await dbWrite.$executeRaw`
      INSERT INTO "ImageAxisRating" AS r (
        "imageId", "source", "sexualLevel", "sexualHighWater", "violenceLevel",
        "rater", "raterVersion", "ratedAt", "workflowId"
      )
      VALUES (
        ${imageId}, 'rated', ${axes.sexual}, ${axes.sexual}, ${axes.violence},
        ${axes.rater}, ${axes.raterVersion}, ${ratedAt}, ${workflowId}
      )
      ON CONFLICT ("imageId") DO UPDATE SET
        "sexualLevel" = CASE WHEN EXCLUDED."ratedAt" > r."ratedAt" THEN EXCLUDED."sexualLevel" ELSE r."sexualLevel" END,
        "sexualHighWater" = GREATEST(r."sexualHighWater", EXCLUDED."sexualLevel"),
        "violenceLevel" = CASE WHEN EXCLUDED."ratedAt" > r."ratedAt" THEN EXCLUDED."violenceLevel" ELSE r."violenceLevel" END,
        "rater" = CASE WHEN EXCLUDED."ratedAt" > r."ratedAt" THEN EXCLUDED."rater" ELSE r."rater" END,
        "raterVersion" = CASE WHEN EXCLUDED."ratedAt" > r."ratedAt" THEN EXCLUDED."raterVersion" ELSE r."raterVersion" END,
        "workflowId" = CASE WHEN EXCLUDED."ratedAt" > r."ratedAt" THEN EXCLUDED."workflowId" ELSE r."workflowId" END,
        "ratedAt" = GREATEST(r."ratedAt", EXCLUDED."ratedAt"),
        "updatedAt" = now()
      -- A late, older result still raises the high-water; it replaces nothing else.
      WHERE r."source" <> 'moderator'
        AND (EXCLUDED."ratedAt" > r."ratedAt" OR EXCLUDED."sexualLevel" > r."sexualHighWater")
    `;
  } catch (error) {
    logToAxiom(
      {
        name: 'image-axis-rating',
        type: 'error',
        message: 'failed to store rating axes',
        reason: error instanceof Error ? error.message : 'Unknown error',
        imageId,
        workflowId,
      },
      'webhooks'
    ).catch(() => null);
  }
}

/**
 * A moderator's axes. They replace the scan's, lower the sexual high-water with the level, and no
 * later scan overwrites them.
 */
export async function setModeratorAxes({
  imageId,
  sexual,
  violence,
  language = null,
  moderatorId,
}: {
  imageId: number;
  sexual: number | null;
  violence: number | null;
  language?: number | null;
  moderatorId: number;
}) {
  await dbWrite.$executeRaw`
    INSERT INTO "ImageAxisRating" (
      "imageId", "source", "sexualLevel", "sexualHighWater", "violenceLevel", "languageLevel",
      "ratedAt", "setBy"
    )
    VALUES (${imageId}, 'moderator', ${sexual}, ${sexual}, ${violence}, ${language}, now(), ${moderatorId})
    ON CONFLICT ("imageId") DO UPDATE SET
      "source" = 'moderator',
      "sexualLevel" = EXCLUDED."sexualLevel",
      "sexualHighWater" = EXCLUDED."sexualHighWater",
      "violenceLevel" = EXCLUDED."violenceLevel",
      "languageLevel" = EXCLUDED."languageLevel",
      "rater" = NULL,
      "raterVersion" = NULL,
      "workflowId" = NULL,
      "ratedAt" = EXCLUDED."ratedAt",
      "setBy" = EXCLUDED."setBy",
      "updatedAt" = now()
  `;
}
