import { parseCivitaiImageId } from '~/utils/civitai-url';

/**
 * The image a drop onto the search bar carries: an image card dragged from the site carries its
 * `/images/<id>` link. A file, or an image with no page link, carries none.
 */
export function imageIdFromDrop(data: Pick<DataTransfer, 'getData'>, hosts: string[] = []) {
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
