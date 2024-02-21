export async function fetchBlob(src: string | Blob | File) {
  let blob: Blob | File | null;
  if (typeof src === 'string')
    blob = await fetch(src)
      .then((response) => response.blob())
      .catch(() => null);
  else blob = src;
  return blob;
}
