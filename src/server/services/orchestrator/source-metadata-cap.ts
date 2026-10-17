import { TRPCError } from '@trpc/server';
import { jsonLengthWithin } from '~/server/schema/blocks/json-length';

/**
 * The longest `sourceMetadata` + `sourceMetadataMap`, in JSON characters, a generation request may
 * carry. It equals the tRPC route's 17mb body limit, so it refuses no request that serializes its
 * metadata in full; it exists so the metadata is measured before it is serialized into each step.
 */
export const SOURCE_METADATA_MAX_CHARS = 17 * 1024 * 1024;

export const SOURCE_METADATA_TOO_LARGE_MESSAGE = 'sourceMetadata is too large';

/**
 * Refuses source metadata whose JSON is longer than SOURCE_METADATA_MAX_CHARS, without building
 * that JSON. A value the measure cannot read (it throws where JSON.stringify throws) is left to the
 * code that serializes it, as before.
 */
export function assertSourceMetadataWithinCap(sourceMetadata: unknown, sourceMetadataMap: unknown) {
  let within = true;
  try {
    within = jsonLengthWithin([sourceMetadata, sourceMetadataMap], SOURCE_METADATA_MAX_CHARS);
  } catch {
    within = true;
  }
  if (!within) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: SOURCE_METADATA_TOO_LARGE_MESSAGE });
  }
}
