export const CIVITAI_MEDIA_ID_MIME = 'application/x-civitai-media-id';
export const CIVITAI_MEDIA_TYPE_MIME = 'application/x-civitai-media-type';

export function setMediaDragData(
  dataTransfer: DataTransfer,
  { url, mediaId, type }: { url: string; mediaId?: number | string; type: 'image' | 'video' }
) {
  dataTransfer.setData('text/uri-list', url);
  if (mediaId === undefined) return;
  dataTransfer.setData(CIVITAI_MEDIA_ID_MIME, String(mediaId));
  dataTransfer.setData(CIVITAI_MEDIA_TYPE_MIME, type);
}
