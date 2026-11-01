import { TRPCError } from '@trpc/server';
import { measureJsonLength } from '~/server/schema/blocks/json-length';

/**
 * The longest `sourceMetadata` + `sourceMetadataMap`, in JSON characters, a generation request may
 * carry. It equals the tRPC route's 17mb body limit (`sizeLimit` in `src/pages/api/trpc/[trpc].ts`;
 * raise both together). It exists so the metadata is measured before it is serialized into each
 * step; with SOURCE_METADATA_MAX_VALUES below, those two are the bound.
 */
export const SOURCE_METADATA_MAX_CHARS = 17 * 1024 * 1024;

/**
 * Values the measure may visit: 262,144, the same as the inline-media walk budget. An image's
 * stored generation metadata holds a few hundred values, so a batch of hundreds of images still
 * fits. The budget is what bounds the walk's cost (the character cap equals the body limit), and
 * the cost grows with it: a quarter of the previous 1,048,576, whose worst case, a single flat
 * object, took roughly half a second.
 */
const SOURCE_METADATA_MAX_VALUES = 256 * 1024;

export const SOURCE_METADATA_TOO_LARGE_MESSAGE = 'sourceMetadata is too large';

/**
 * Refuses source metadata whose JSON is longer than SOURCE_METADATA_MAX_CHARS, without building
 * that JSON. An unserializable value is left to the code that serializes it, as before.
 */
export function assertSourceMetadataWithinCap(sourceMetadata: unknown, sourceMetadataMap: unknown) {
  const meter = { visits: 0, chars: 0, scanned: 0, maxVisits: SOURCE_METADATA_MAX_VALUES };
  if (
    measureJsonLength([sourceMetadata, sourceMetadataMap], SOURCE_METADATA_MAX_CHARS, { meter }) ===
    'over'
  ) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: SOURCE_METADATA_TOO_LARGE_MESSAGE });
  }
}
