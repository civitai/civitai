import type { Context } from '~/server/createContext';
import { getInfiniteImagesHandler } from '~/server/controllers/image.controller';
import { getModelsFeed } from '~/server/controllers/model.controller';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import type { GetEmbedAvailabilityInput } from '~/server/schema/civitai-embed.schema';
import { clampToDomainCap, requestServableLevels } from '~/server/utils/browsing-level';
import { Flags } from '~/shared/utils/flags';

export type EmbedAvailability = { id: number; available: boolean; aboveViewerLevel: boolean };

/**
 * Whether each card would show for this viewer, and if not, whether it is a public item above
 * their level. Answers with booleans only: the feeds run for an anonymous viewer, so owner and
 * moderator carve-outs never reach the answer, and private, unpublished, deleted, held, POI and
 * minor items read exactly as a missing id. The widest level is this request's own domain cap,
 * so a signed-out caller learns nothing above PG.
 */
export async function getEmbedAvailabilityHandler({
  input,
  ctx,
}: {
  input: GetEmbedAvailabilityInput;
  ctx: Context;
}) {
  const widest = requestServableLevels(ctx);
  const viewerLevel = clampToDomainCap(input.browsingLevel, widest);
  const anonymous: Context = { ...ctx, user: undefined };
  const filters = { browsingLevel: widest, disablePoi: true, disableMinor: true };

  const [models, images] = await Promise.all([
    input.modelIds.length
      ? getModelsFeed(
          getAllModelsSchema.parse({
            ...filters,
            ids: input.modelIds,
            limit: input.modelIds.length,
          }),
          anonymous
        ).then((r) => r.items)
      : [],
    input.imageIds.length
      ? getInfiniteImagesHandler({
          input: getInfiniteImagesSchema.parse({
            ...filters,
            ids: input.imageIds,
            limit: input.imageIds.length,
            // Only id and nsfwLevel are read, so skip the default cosmetics hydration.
            include: [],
          }),
          ctx: anonymous,
        }).then((r) => r.items)
      : [],
  ]);

  return {
    models: toAvailability(input.modelIds, models, { viewerLevel, widest }),
    images: toAvailability(input.imageIds, images, { viewerLevel, widest }),
  };
}

/**
 * One row per requested id, in request order; nothing from an item but whether its level fits.
 * An item outside the request's cap counts as missing even if a feed returned it.
 */
function toAvailability(
  ids: number[],
  found: { id: number; nsfwLevel: number }[],
  { viewerLevel, widest }: { viewerLevel: number; widest: number }
): EmbedAvailability[] {
  const levels = new Map(
    found
      .filter((item) => Flags.intersects(item.nsfwLevel, widest))
      .map((item) => [item.id, item.nsfwLevel])
  );
  return ids.map((id) => {
    const level = levels.get(id);
    const available = level !== undefined && Flags.intersects(level, viewerLevel);
    return { id, available, aboveViewerLevel: level !== undefined && !available };
  });
}
