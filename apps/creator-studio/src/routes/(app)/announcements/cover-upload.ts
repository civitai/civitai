export type CoverUpload = {
  key: string;
  width: number | null;
  height: number | null;
  mimeType: string;
  sizeKB: number;
  previewUrl: string;
};

export const COVER_MAX_BYTES = 10 * 1024 * 1024;
export const COVER_ACCEPT = 'image/jpeg,image/png,image/webp';

async function readDimensions(
  file: File
): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Uploads a cover and returns the object KEY. It is not an `Image` row and must not be treated as
 * one — the main app mints the row on save, which is what gets the cover ingested and scanned.
 */
export async function uploadCover(file: File): Promise<CoverUpload> {
  if (file.size > COVER_MAX_BYTES) throw new Error('Cover images must be under 10MB.');

  const res = await fetch('/api/announcement-cover', { method: 'POST' });
  if (!res.ok) throw new Error('Could not start the upload. Please try again.');
  const { id, uploadURL } = (await res.json()) as { id: string; uploadURL: string };

  const put = await fetch(uploadURL, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!put.ok) throw new Error('The image could not be uploaded. Please try again.');

  const { width, height } = await readDimensions(file);
  return {
    key: id,
    width,
    height,
    mimeType: file.type,
    sizeKB: Math.round(file.size / 1024),
    previewUrl: URL.createObjectURL(file),
  };
}
