/**
 * Only an image file can carry `imageMetadata`. Video and audio provenance rides on the workflow
 * metadata (`remix-provenance.ts`), and stricter orchestrator inputs (Flux 3 Max) reject the member.
 */
const STEP_TYPES_WITH_IMAGE_METADATA: readonly string[] = ['imageGen', 'comfy'];

export function withImageMetadata(input: object, type: string, imageMetadata: string): object {
  if (!STEP_TYPES_WITH_IMAGE_METADATA.includes(type)) return input;
  return { ...input, imageMetadata };
}
