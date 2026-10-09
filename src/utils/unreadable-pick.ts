import pLimit from 'p-limit';

/** How long a pick's read at pick time may take before the pick is treated as readable. */
export const UNREADABLE_PROBE_TIMEOUT_MS = 3_000;
/** Full pick-time reads in flight at once, so a large multi-file pick is not all in memory twice. */
const SNAPSHOT_CONCURRENCY = 4;

type PickRead<T> =
  | { status: 'read'; value: T }
  | { status: 'unreadable'; error: DOMException }
  /** Timed out, or failed some other way: left to the upload pipeline. */
  | { status: 'unknown' };

/**
 * Only a `NotReadableError` rejection counts as unreadable. A read that has not settled after
 * `timeoutMs` (a cloud-only photo the provider is still downloading) is left to the upload
 * pipeline, whose own steps are time-bounded.
 */
async function readWithin<T>(read: () => Promise<T>, timeoutMs: number): Promise<PickRead<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PickRead<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unknown' }), timeoutMs);
  });
  // Started inside a promise so a read that throws rather than rejects is handled the same way.
  const result = Promise.resolve()
    .then(read)
    .then(
      (value): PickRead<T> => ({ status: 'read', value }),
      (e): PickRead<T> =>
        (e as { name?: unknown } | null)?.name === 'NotReadableError'
          ? { status: 'unreadable', error: e as DOMException }
          : { status: 'unknown' }
    );
  try {
    return await Promise.race([result, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Some Android photo pickers (opened by a file input whose `accept` lists only images) hand the page
 * a File whose bytes no API can read: every read rejects with `NotReadableError`. The same photo
 * chosen through the Files app reads fine, so the remedy is to offer that chooser instead.
 */
export async function probeUnreadablePick(
  file: File,
  timeoutMs = UNREADABLE_PROBE_TIMEOUT_MS
): Promise<DOMException | undefined> {
  const result = await readWithin(() => file.slice(0, 16).arrayBuffer(), timeoutMs);
  return result.status === 'unreadable' ? result.error : undefined;
}

const snapshots = new WeakSet<File>();

/** Whether `file` is an in-memory copy taken at the pick, so no later read of it can be refused. */
export function isPickSnapshot(file: File) {
  return snapshots.has(file);
}

/**
 * A picker File can also turn unreadable seconds after the pick, once a first read has succeeded.
 * So an image is read in full now and replaced by an in-memory copy that later stages read instead.
 * A file that is not an image or is over `maxBytes` is only probed, and kept as it is.
 */
export async function snapshotPick(
  file: File,
  { maxBytes, timeoutMs = UNREADABLE_PROBE_TIMEOUT_MS }: { maxBytes: number; timeoutMs?: number }
): Promise<{ file: File; error?: undefined } | { file?: undefined; error: DOMException }> {
  if (!file.type.startsWith('image/') || file.size > maxBytes) {
    const error = await probeUnreadablePick(file, timeoutMs);
    return error ? { error } : { file };
  }
  const result = await readWithin(() => file.arrayBuffer(), timeoutMs);
  if (result.status === 'unreadable') return { error: result.error };
  if (result.status === 'unknown') return { file };
  const copy = new File([result.value], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
  snapshots.add(copy);
  return { file: copy };
}

/**
 * Splits picked files into those the picker made unreadable and the rest. `readable` holds what to
 * use in place of each readable pick, in order; `replacements` maps a pick to the same.
 */
export async function splitUnreadablePicks(files: File[], options: { maxBytes: number }) {
  const limit = pLimit(SNAPSHOT_CONCURRENCY);
  const picks = await Promise.all(
    files.map((original) =>
      limit(async () => ({ original, ...(await snapshotPick(original, options)) }))
    )
  );
  const replacements = new Map<File, File>();
  const unreadable: { file: File; error: DOMException }[] = [];
  for (const pick of picks) {
    if (pick.error) unreadable.push({ file: pick.original, error: pick.error });
    else replacements.set(pick.original, pick.file);
  }
  return { readable: [...replacements.values()], unreadable, replacements };
}

/**
 * Whether a read of a picked file failed the way an unreadable picker File fails: a
 * `NotReadableError`, a `TypeError` from fetching its blob: url, or an `<img>` load error (an Error
 * caused by the element's `error` Event).
 */
export function isReadFailure(e: unknown) {
  if ((e as { name?: unknown } | null)?.name === 'NotReadableError') return true;
  if (e instanceof TypeError) return true;
  return e instanceof Error && typeof Event !== 'undefined' && e.cause instanceof Event;
}

/**
 * The text for `count` unreadable picks. Only on Android is the Files chooser offered: elsewhere the
 * same OS dialog would hand over the same file, so the text just asks for another try.
 */
export function unreadablePickMessage(count: number, android: boolean) {
  if (android)
    return count > 1
      ? `Your phone's photo picker gave us ${count} files we can't open. Choose them from Files instead.`
      : "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";
  return count > 1
    ? `We couldn't open ${count} of these files. Try choosing them again.`
    : "We couldn't open this file. Try choosing it again.";
}

const MB = 1024 * 1024;
const REPORTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
];

/** A picked file's type (from a short list) and size bucket, for a bounded failure report. */
export function boundedFileFields(file: { type: string; size: number }) {
  return {
    type: REPORTED_TYPES.includes(file.type) ? file.type : 'other',
    size: file.size < 5 * MB ? '<5MB' : file.size <= 20 * MB ? '5-20MB' : '>20MB',
  };
}
