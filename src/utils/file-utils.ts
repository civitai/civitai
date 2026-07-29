// Anti-hang ceiling only: a hung upstream would otherwise park the request for
// undici's ~300s default. Generous by design — callers downloading large media
// (video/zip) pass a bigger timeoutMs rather than risk cutting off a slow-but-legit transfer.
export async function fetchBlob(src: string | Blob | File, timeoutMs = 120_000) {
  if (src instanceof Blob) return src;
  // Intentionally NOT behind the hot-path-fetch-timeouts Flipt kill-switch: this
  // is isomorphic (bundled client-side) so it can't import the server-only
  // isFliptSync, and its callers are background/media downloads where an abort is benign.
  else
    return await fetch(src, { signal: AbortSignal.timeout(timeoutMs) }).then((response) =>
      response.blob().catch(() => null)
    );
}

/** Trigger a browser download for the given blob with the provided filename. */
export function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(href);
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
