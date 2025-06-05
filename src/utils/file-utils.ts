export async function fetchBlob(src: string | Blob | File) {
  if (src instanceof Blob) return src;
  else return await fetch(src).then((response) => response.blob().catch(() => null));
}

export function blobToFile(
  blob: Blob,
  filename = new Date().getTime().toString(),
  type = blob.type
) {
  return new File([blob], filename, { type });
}

export async function fetchBlobAsFile(src: string | Blob | File, filename?: string) {
  if (src instanceof File) return src;
  const blob = await fetchBlob(src);
  if (!blob) return null;
  let type = blob.type;

  // have to do this to handle cases where content-type is application/octet-stream
  if (typeof src === 'string') {
    if (src.endsWith('.mp4')) type = 'video/mp4';
    else if (src.endsWith('.jpg') || src.endsWith('.jpeg')) type = 'image/jpeg';
  }
  return blobToFile(blob, filename, type);
}

export async function fetchBlobAsBase64(src: string | Blob | File) {
  const blob = await fetchBlob(src);
  if (!blob) return null;
  return getBase64(blob);
}

export const getBase64 = (blob: Blob | File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!reader.result) throw new Error('failed to read blob');
      const base64 =
        typeof reader.result === 'string' ? reader.result : new TextDecoder().decode(reader.result);
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
