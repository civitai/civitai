import { imageGenerationSchema } from '~/server/schema/image.schema';

/**
 * The collections index ships `prompt` and nothing else.
 *
 * `meta.hashes`, `meta.effects` and `meta.external.details` are records whose KEYS are
 * user-supplied resource names (`lora:<name>`, …). Meilisearch flattens nested objects
 * into dotted field names and mints one field id per distinct name, index-wide — a u16
 * space of 65,536 that is never reclaimed, not a per-document budget. Shipping meta
 * wholesale minted a field id per LoRA anyone had ever used, exhausted the map on
 * collections_v3, and every write to the index failed with a per-document error message.
 *
 * Nothing under `images[].meta` is searchable or filterable, and `prompt` is the only
 * field read (CollectionCard alt text). Keep this a FIXED key set: any field whose keys
 * come from user data will exhaust the map again.
 */
const collectionImageMetaSchema = imageGenerationSchema.pick({ prompt: true }).partial();

export const parseCollectionImageMeta = (meta: unknown): { prompt?: string } => {
  const parsed = collectionImageMetaSchema.safeParse(meta);
  return parsed?.success ? parsed.data : {};
};
