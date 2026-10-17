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
 * Values the measure may visit: 1,048,576, far above what an image's generation metadata holds and
 * four times the default walk budget, so a request carrying several images with large workflows
 * still fits. Not half the character cap, which would let one request spend several hundred
 * milliseconds in the walk.
 */
const SOURCE_METADATA_MAX_VALUES = 1024 * 1024;

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
