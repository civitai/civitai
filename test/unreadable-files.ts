/** Every read of a File named `unreadable…` rejects, the way a photo-picker file's reads do. */
export function makeUnreadableFilesFail() {
  const { slice, arrayBuffer } = Blob.prototype;
  const notReadable = () =>
    Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError'));
  const isUnreadable = (blob: Blob) => blob instanceof File && blob.name.startsWith('unreadable');
  Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob['slice']>) {
    const part = slice.apply(this, args);
    if (isUnreadable(this)) part.arrayBuffer = notReadable;
    return part;
  };
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return isUnreadable(this) ? notReadable() : arrayBuffer.call(this);
  };
  return () => {
    Blob.prototype.slice = slice;
    Blob.prototype.arrayBuffer = arrayBuffer;
  };
}

/**
 * A part sliced from a File named `slow…` never finishes reading, the way a cloud-only photo can
 * stall while its provider downloads it. Only slices stall (what the readability probe reads), so
 * the rest of the upload pipeline runs normally.
 */
export function makeSlowFilesStall() {
  const { slice } = Blob.prototype;
  Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob['slice']>) {
    const part = slice.apply(this, args);
    if (this instanceof File && this.name.startsWith('slow'))
      part.arrayBuffer = () => new Promise<ArrayBuffer>(() => undefined);
    return part;
  };
  return () => {
    Blob.prototype.slice = slice;
  };
}

/**
 * Picks files the way the browser's chooser does, keeping these File objects: `userEvent.upload`
 * serialises each file and the page receives new ones, so a file set up to fail its reads would not
 * arrive as one.
 */
export async function chooseFiles(
  target: HTMLInputElement | Promise<HTMLInputElement>,
  files: File[]
) {
  const input = await target;
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
}
