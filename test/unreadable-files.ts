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
 * A File named `slow…`, or a part sliced from one, never finishes an `arrayBuffer()` read, the
 * way a cloud-only photo can stall while its provider downloads it. That is how the pick-time read
 * sees it; the rest of the upload pipeline runs normally.
 */
export function makeSlowFilesStall() {
  const { slice, arrayBuffer } = Blob.prototype;
  const stall = () => new Promise<ArrayBuffer>(() => undefined);
  const isSlow = (blob: Blob) => blob instanceof File && blob.name.startsWith('slow');
  Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob['slice']>) {
    const part = slice.apply(this, args);
    if (isSlow(this)) part.arrayBuffer = stall;
    return part;
  };
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return isSlow(this) ? stall() : arrayBuffer.call(this);
  };
  return () => {
    Blob.prototype.slice = slice;
    Blob.prototype.arrayBuffer = arrayBuffer;
  };
}

/**
 * A File named `uncopied…` fails its full `arrayBuffer()` read with an error other than
 * NotReadableError, so the pick-time copy is not taken and the pick goes on as the device's own
 * file (as it does when that read times out). Sliced parts read normally.
 */
export function makeFullReadsFail() {
  const { arrayBuffer } = Blob.prototype;
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return this instanceof File && this.name.startsWith('uncopied')
      ? Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
      : arrayBuffer.call(this);
  };
  return () => {
    Blob.prototype.arrayBuffer = arrayBuffer;
  };
}

/**
 * Files made by the returned `expiringFile` read once and then turn unreadable, the way some
 * photo-picker Files do seconds after the pick: the first read succeeds, and after it every read
 * rejects with NotReadableError and every blob: url made for the file fails to load. A copy of its
 * bytes (another File object) is unaffected.
 */
export function makeFilesExpireAfterFirstRead() {
  const { slice, arrayBuffer, text } = Blob.prototype;
  const { createObjectURL } = URL;
  const expiring = new WeakSet<Blob>();
  const read = new WeakSet<Blob>();
  const notReadable = () =>
    Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError'));
  /** Counts this read; true once the file has expired. */
  const expiredOn = (blob: Blob) => {
    if (!expiring.has(blob)) return false;
    if (read.has(blob)) return true;
    read.add(blob);
    return false;
  };
  Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob['slice']>) {
    const part = slice.apply(this, args);
    if (expiredOn(this)) part.arrayBuffer = notReadable;
    return part;
  };
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return expiredOn(this) ? notReadable() : arrayBuffer.call(this);
  };
  Blob.prototype.text = function (this: Blob) {
    return expiredOn(this) ? notReadable() : text.call(this);
  };
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = createObjectURL.call(URL, obj);
    if (obj instanceof Blob && expiredOn(obj)) URL.revokeObjectURL(url);
    return url;
  };
  const expiringFile = (file: File) => {
    expiring.add(file);
    return file;
  };
  return {
    expiringFile,
    restore: () => {
      Blob.prototype.slice = slice;
      Blob.prototype.arrayBuffer = arrayBuffer;
      Blob.prototype.text = text;
      URL.createObjectURL = createObjectURL;
    },
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
