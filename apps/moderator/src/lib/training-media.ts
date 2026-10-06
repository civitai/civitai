// What counts as renderable training media, shared by the zip reader (`training-zip.ts`) and the
// workflow-only dataset reader — no JSZip here, so the server can import it.
//
// Mirrors the main app's MIME_TYPES / MEDIA_TYPE tables: anything outside them is not rendered, so a
// caption .txt or a stray dotfile never reaches the grid as an unrenderable tile.
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/vnd.wave',
};

const KIND_BY_MIME: Record<string, TrainingAssetKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/vnd.wave': 'audio',
};

export type TrainingAssetKind = 'image' | 'video' | 'audio';
export type TrainingAsset = {
  url: string;
  name: string;
  mimeType: string;
  kind: TrainingAssetKind;
  /** The item's training caption, where the source carries one beside the media. */
  caption?: string | null;
};

/** The MIME type and kind for a file name, or null when it is not renderable training media. */
export function trainingMediaOf(
  name: string
): { mimeType: string; kind: TrainingAssetKind } | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = MIME_BY_EXT[ext];
  const kind = mimeType ? KIND_BY_MIME[mimeType] : undefined;
  return mimeType && kind ? { mimeType, kind } : null;
}
