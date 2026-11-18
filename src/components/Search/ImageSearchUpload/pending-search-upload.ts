/**
 * A file dropped on the search bar, handed to the search-by-image page it opens. Kept in memory
 * only: an upload is never put in the URL, so a search by upload cannot be shared.
 */
let pending: File | null = null;

export function setPendingSearchUpload(file: File) {
  pending = file;
}

export function takePendingSearchUpload() {
  const file = pending;
  pending = null;
  return file;
}

export const SEARCH_UPLOAD_ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

export function searchUploadFileFromDrop(data: Pick<DataTransfer, 'files'>) {
  const file = data.files?.[0];
  return file && SEARCH_UPLOAD_ACCEPT.includes(file.type) ? file : undefined;
}
