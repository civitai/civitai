import { dbRead } from '~/server/db/client';
import {
  baseModelByName,
  crossEcosystemRules,
  ecosystemById,
  getRootEcosystem,
} from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';

/**
 * Whether a challenge's featured resource can run on the checkpoint an entry was made with: the
 * same ecosystem, or a generation `crossEcosystemRules` row (Pony <-> SDXL, Flux1 <-> FluxKrea…).
 *
 * This is the rule `getGenerationSupport` applies, without its on-site gates: that function also
 * says no when the site does not generate with an ecosystem or model type (Krea 3 LoRAs, say),
 * which would refuse an off-site entry that is perfectly compatible.
 *
 * A base model the table does not know, the catch-all 'Other', or a type no cross-ecosystem rule
 * describes (ControlNet, Upscaler…) passes: the rule refuses only a mismatch it can prove.
 */
export function isFeaturedResourceCompatible(
  checkpointBaseModel: string,
  resourceBaseModel: string,
  resourceType: ModelType
): boolean {
  const checkpoint = baseModelByName.get(checkpointBaseModel);
  const resource = baseModelByName.get(resourceBaseModel);
  if (!checkpoint || !resource) return true;
  if (isOther(checkpoint.ecosystemId) || isOther(resource.ecosystemId)) return true;
  if (checkpoint.ecosystemId === resource.ecosystemId) return true;
  if (!ruledModelTypes.has(resourceType)) return true;

  const rootId = getRootEcosystem(checkpoint.ecosystemId).id;
  return crossEcosystemRules.some(
    (rule) =>
      rule.supportType === 'generation' &&
      rule.sourceEcosystemId === resource.ecosystemId &&
      (rule.targetEcosystemId === checkpoint.ecosystemId || rule.targetEcosystemId === rootId) &&
      (!rule.modelTypes || rule.modelTypes.includes(resourceType))
  );
}

// The cross-ecosystem rules list LoRA-family types, embeddings, VAEs and checkpoints; for any other
// type they say nothing about compatibility, so they cannot prove a mismatch.
const ruledModelTypes = new Set<ModelType>(crossEcosystemRules.flatMap((r) => r.modelTypes ?? []));

function isOther(ecosystemId: number) {
  return ecosystemById.get(ecosystemId)?.key === 'Other';
}

export type EntryResourceRow = {
  imageId: number;
  baseModel: string;
  type: ModelType;
  isFeatured: boolean;
};

/**
 * Images whose featured resource fits none of their detected checkpoints. ANY featured version on
 * ANY checkpoint is enough: refiner and upscale passes list several checkpoints. No checkpoint
 * (an off-site run on one Civitai does not host) passes.
 */
export function findIncompatibleEntries(rows: EntryResourceRow[]): Set<number> {
  const byImage = new Map<number, EntryResourceRow[]>();
  for (const row of rows) {
    const list = byImage.get(row.imageId) ?? [];
    list.push(row);
    byImage.set(row.imageId, list);
  }

  const incompatible = new Set<number>();
  for (const [imageId, resources] of byImage) {
    const featured = resources.filter((r) => r.isFeatured);
    const checkpoints = resources.filter((r) => r.type === 'Checkpoint');
    if (!featured.length || !checkpoints.length) continue;
    if (featured.some((f) => f.type === 'Checkpoint')) continue;
    const compatible = featured.some((f) =>
      checkpoints.some((c) => isFeaturedResourceCompatible(c.baseModel, f.baseModel, f.type))
    );
    if (!compatible) incompatible.add(imageId);
  }
  return incompatible;
}

/**
 * One query for a whole batch. Detected rows only, for the checkpoint as for the featured
 * resource: a `detected: false` row is asserted by the uploader.
 */
export async function getIncompatibleEntryImageIds(
  imageIds: number[],
  featuredVersionIds: number[],
  db: Pick<typeof dbRead, '$queryRaw'> = dbRead
): Promise<Set<number>> {
  if (!imageIds.length || !featuredVersionIds.length) return new Set();
  const rows = await db.$queryRaw<EntryResourceRow[]>`
    SELECT
      ir."imageId",
      mv."baseModel",
      m.type,
      mv.id = ANY(${featuredVersionIds}) AS "isFeatured"
    FROM "ImageResourceNew" ir
    JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ir."imageId" = ANY(${imageIds})
      AND ir.detected IS TRUE
      AND (mv.id = ANY(${featuredVersionIds}) OR m.type = 'Checkpoint')
  `;
  return findIncompatibleEntries(rows);
}

export const INCOMPATIBLE_BASE_MODEL_REASON = 'Incompatible base model';

export const INCOMPATIBLE_BASE_MODEL_MESSAGE =
  "This image's checkpoint isn't compatible with the challenge's featured resource. Use a checkpoint from the same base model family as the featured resource (for example, a Pony LoRA on a Pony, SDXL or Illustrious checkpoint).";
