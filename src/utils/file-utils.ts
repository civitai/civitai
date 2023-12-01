export async function fetchBlob(src: string | Blob | File) {
  let blob: Blob | File;
  if (typeof src === 'string') blob = await fetch(src).then((response) => response.blob());
  else blob = src;
  return blob;
}
