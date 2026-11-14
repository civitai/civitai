export const CIVITAI_MEDIA_ID_MIME = 'application/x-civitai-media-id';
export const CIVITAI_MEDIA_TYPE_MIME = 'application/x-civitai-media-type';

export function setMediaDragData(
  dataTransfer: DataTransfer,
  { url, mediaId, type }: { url: string; mediaId?: number | string; type: 'image' | 'video' }
) {
  // a <video> resolves to '' until resource selection settles, and writing that
  // replaces the browser's own entry with nothing a drop target can use
  if (url) dataTransfer.setData('text/uri-list', url);
  if (mediaId === undefined) return;
  dataTransfer.setData(CIVITAI_MEDIA_ID_MIME, String(mediaId));
  dataTransfer.setData(CIVITAI_MEDIA_TYPE_MIME, type);
}

/** The site media a drag carries, as `setMediaDragData` wrote it. */
export function getMediaDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>
): { id: number; type: 'image' | 'video' } | undefined {
  const raw = dataTransfer.getData(CIVITAI_MEDIA_ID_MIME);
  if (!raw) return undefined;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return undefined;
  const type = dataTransfer.getData(CIVITAI_MEDIA_TYPE_MIME);
  return { id, type: type === 'video' ? 'video' : 'image' };
}
