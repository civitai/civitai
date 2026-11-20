import { readVideoTags } from '~/utils/metadata/video-tags';

type VideoContainer = 'mp4' | 'webm';
type MetadataValue = string | Record<string, unknown>;

export async function detectVideoContainer(blob: Blob): Promise<VideoContainer | undefined> {
  if (blob.size < 8) return undefined;
  try {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (new DataView(head.buffer).getUint32(0) === 0x1a45dfa3) return 'webm';
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return 'mp4';
  } catch {}
  return undefined;
}

/** Normalize container tags for the shared generation metadata parsers. */
export async function readVideoMetadata(blob: Blob): Promise<Record<string, MetadataValue>> {
  const tags = await readVideoTags(blob);
  const metadata: Record<string, MetadataValue> = { ...tags };
  if (tags.extraMetadata) {
    try {
      const parsed = JSON.parse(tags.extraMetadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        metadata.extraMetadata = parsed;
    } catch {}
  }
  return metadata;
}
