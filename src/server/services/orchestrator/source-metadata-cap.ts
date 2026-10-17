import { TRPCError } from '@trpc/server';
import { measureJsonLength } from '~/server/schema/blocks/json-length';

/**
 * The longest `sourceMetadata` + `sourceMetadataMap`, in JSON characters, a generation request may
 * carry. It equals the tRPC route's 17mb body limit (`sizeLimit` in `src/pages/api/trpc/[trpc].ts`;
 * raise both together), so it refuses no request whose metadata arrives written out in full; it
 * exists so the metadata is measured before it is serialized into each step.
 */
export const SOURCE_METADATA_MAX_CHARS = 17 * 1024 * 1024;

/**
 * Values the measure may visit. Every value JSON.stringify writes costs at least two characters,
 * so metadata within SOURCE_METADATA_MAX_CHARS that writes out every entry needs no more.
 */
const SOURCE_METADATA_MAX_VISITS = SOURCE_METADATA_MAX_CHARS / 2;

export const SOURCE_METADATA_TOO_LARGE_MESSAGE = 'sourceMetadata is too large';

/**
 * Refuses source metadata whose JSON is longer than SOURCE_METADATA_MAX_CHARS, without building
 * that JSON. An unserializable value is left to the code that serializes it, as before.
 */
export function assertSourceMetadataWithinCap(sourceMetadata: unknown, sourceMetadataMap: unknown) {
  const meter = { visits: 0, chars: 0, scanned: 0, maxVisits: SOURCE_METADATA_MAX_VISITS };
  if (
    measureJsonLength([sourceMetadata, sourceMetadataMap], SOURCE_METADATA_MAX_CHARS, { meter }) ===
    'over'
  ) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: SOURCE_METADATA_TOO_LARGE_MESSAGE });
  }
}
