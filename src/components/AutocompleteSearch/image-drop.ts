import { CIVITAI_MEDIA_ID_MIME, getMediaDragData } from '~/components/EdgeMedia/media-drag-data';
import { parseCivitaiImageId } from '~/utils/civitai-url';

/** Whether a drag may carry a site image; only the types are readable before the drop. */
export const mayCarryImage = (types: readonly string[]) =>
  types.includes(CIVITAI_MEDIA_ID_MIME) || types.includes('text/uri-list');

/**
 * The image a drop carries. A site image writes its id (and its CDN URL as the link); failing that,
 * a dragged `/images/<id>` link. `hosts` adds the current host, so a drop works off the site's own
 * domains too (dev). Videos are not embedded, so they carry nothing.
 */
export function imageIdFromDrop(data: Pick<DataTransfer, 'getData'>, hosts: string[] = []) {
  const media = getMediaDragData(data);
  if (media) return media.type === 'image' ? media.id : undefined;
  for (const type of ['text/uri-list', 'text/plain']) {
    const lines = data
      .getData(type)
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'));
    for (const line of lines) {
      const imageId = parseCivitaiImageId(line, { hosts });
      if (imageId) return imageId;
    }
  }
}
