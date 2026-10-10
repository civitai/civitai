/** How long a pick's read at pick time may take before the pick is treated as readable. */
export const UNREADABLE_PROBE_TIMEOUT_MS = 3_000;
/**
 * Pick-time reads in flight at once, so a large multi-file pick is not all in memory twice. A read
 * counts against this until it settles, even after its pick stopped waiting for it.
 */
const SNAPSHOT_CONCURRENCY = 4;

type PickRead<T> =
  | { status: 'read'; value: T }
  | { status: 'unreadable'; error: DOMException }
  /** Failed some other way: left to the upload pipeline. */
  | { status: 'unknown' }
  /** Not settled in time (a cloud-only photo still downloading): left to the upload pipeline. */
  | { status: 'timed-out' };

/**
 * Starts `read`. `outcome` settles when the read does or after `timeoutMs`, whichever is first;
 * `settled` only when the read itself does, which can be long after a timeout. Only a
 * `NotReadableError` rejection counts as unreadable.
 */
function readWithin<T>(read: () => Promise<T>, timeoutMs: number) {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PickRead<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
  });
  const outcome = Promise.race([result, timedOut]).finally(() => clearTimeout(timer));
  return { outcome, settled: result.then(() => undefined) };
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
  const result = await readWithin(() => file.slice(0, 16).arrayBuffer(), timeoutMs).outcome;
  return result.status === 'unreadable' ? result.error : undefined;
}

const snapshots = new WeakSet<File>();
const originals = new WeakMap<File, File>();

/** Whether `file` is held in memory (a copy taken at the pick), so no later read of it can be refused. */
export function isPickSnapshot(file: File) {
  return snapshots.has(file);
}

/** Marks a File the page built in memory (say from a dropped url), so it is not taken for a pick. */
export function markInMemory(file: File) {
  snapshots.add(file);
  return file;
}

/** The picked File a pick-time copy was taken from; any other file is its own original. */
export function pickOriginal(file: File) {
  return originals.get(file) ?? file;
}

type SnapshotResult = { file: File; error?: undefined } | { file?: undefined; error: DOMException };
type SnapshotOptions = { maxBytes: number; timeoutMs?: number };

/** `outcome` is the pick's result; `settled` is when the read behind it has settled. */
function startSnapshot(
  file: File,
  { maxBytes, timeoutMs = UNREADABLE_PROBE_TIMEOUT_MS }: SnapshotOptions
): { outcome: Promise<SnapshotResult & { timedOut: boolean }>; settled: Promise<void> } {
  if (!file.type.startsWith('image/') || file.size > maxBytes) {
    const { outcome, settled } = readWithin(() => file.slice(0, 16).arrayBuffer(), timeoutMs);
    return {
      outcome: outcome.then((r) =>
        r.status === 'unreadable'
          ? { error: r.error, timedOut: false }
          : { file, timedOut: r.status === 'timed-out' }
      ),
      settled,
    };
  }
  const { outcome, settled } = readWithin(() => file.arrayBuffer(), timeoutMs);
  return {
    outcome: outcome.then((r) => {
      if (r.status === 'unreadable') return { error: r.error, timedOut: false };
      if (r.status !== 'read') return { file, timedOut: r.status === 'timed-out' };
      const copy = new File([r.value], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      });
      snapshots.add(copy);
      originals.set(copy, file);
      return { file: copy, timedOut: false };
    }),
    settled,
  };
}

/**
 * A picker File can also turn unreadable seconds after the pick, once a first read has succeeded.
 * So an image is read in full now and replaced by an in-memory copy that later stages read instead.
 * A file that is not an image or is over `maxBytes` is only probed, and kept as it is.
 */
export async function snapshotPick(file: File, options: SnapshotOptions): Promise<SnapshotResult> {
  const { file: kept, error } = await startSnapshot(file, options).outcome;
  return error ? { error } : { file: kept! };
}

/**
 * Snapshots `files` with at most SNAPSHOT_CONCURRENCY reads in flight. A read that times out keeps
 * its slot until it settles (its pick goes on as the device's own file meanwhile); once every slot
 * holds such a read, the picks still waiting go on the same way without being read.
 */
function snapshotAll(files: File[], options: SnapshotOptions) {
  return new Promise<SnapshotResult[]>((resolve) => {
    const results: SnapshotResult[] = new Array(files.length);
    let next = 0;
    let inFlight = 0;
    let stalled = 0;
    let remaining = files.length;
    const finish = (i: number, result: SnapshotResult) => {
      results[i] = result;
      if (--remaining === 0) resolve(results);
    };
    const pump = () => {
      if (stalled === SNAPSHOT_CONCURRENCY) {
        while (next < files.length) {
          const i = next++;
          finish(i, { file: files[i] });
        }
        return;
      }
      while (next < files.length && inFlight < SNAPSHOT_CONCURRENCY) {
        const i = next++;
        inFlight++;
        let readSettled = false;
        let countedStalled = false;
        const { outcome, settled } = startSnapshot(files[i], options);
        void outcome.then(({ timedOut, ...result }) => {
          if (timedOut && !readSettled) {
            countedStalled = true;
            stalled++;
          }
          finish(i, result as SnapshotResult);
          pump();
        });
        void settled.then(() => {
          readSettled = true;
          inFlight--;
          if (countedStalled) stalled--;
          pump();
        });
      }
    };
    if (!files.length) resolve(results);
    else pump();
  });
}

/**
 * Splits picked files into those the picker made unreadable and the rest. `readable` holds what to
 * use in place of each readable pick, in order; `replacements` maps a pick to the same.
 */
export async function splitUnreadablePicks(files: File[], options: SnapshotOptions) {
  const results = await snapshotAll(files, options);
  const replacements = new Map<File, File>();
  const unreadable: { file: File; error: DOMException }[] = [];
  results.forEach((result, i) => {
    if (result.error) unreadable.push({ file: files[i], error: result.error });
    else replacements.set(files[i], result.file);
  });
  return { readable: [...replacements.values()], unreadable, replacements };
}

/**
 * Blob urls made for picked files. A url is revoked once it is released and no read holds it, so
 * an in-memory copy of a pick is freed when nothing needs it, without failing a read still using it.
 */
export function createPickUrls() {
  const urls = new Map<string, { holds: number; released: boolean }>();
  const revokeIfDone = (url: string) => {
    const entry = urls.get(url);
    if (!entry?.released || entry.holds) return;
    urls.delete(url);
    URL.revokeObjectURL(url);
  };
  const release = (url: string) => {
    const entry = urls.get(url);
    if (!entry) return;
    entry.released = true;
    revokeIfDone(url);
  };
  return {
    create(file: Blob) {
      const url = URL.createObjectURL(file);
      urls.set(url, { holds: 0, released: false });
      return url;
    },
    /** Keeps `url` until `work` settles. A url this did not make is ignored. */
    hold(url: string, work: Promise<unknown>) {
      const entry = urls.get(url);
      if (!entry) return;
      entry.holds++;
      const done = () => {
        entry.holds--;
        revokeIfDone(url);
      };
      work.then(done, done);
    },
    release,
    /** Releases every url not in `inUse`. */
    releaseAllBut(inUse: ReadonlySet<string>) {
      for (const url of [...urls.keys()]) if (!inUse.has(url)) release(url);
    },
  };
}

/** What each engine's `fetch` rejects with when it cannot load the url (Chromium, Firefox, WebKit). */
const FETCH_FAILURE_MESSAGES = [
  'Failed to fetch',
  'NetworkError when attempting to fetch resource.',
  'Load failed',
];

/**
 * Whether a read of a picked file failed the way an unreadable picker File fails: a
 * `NotReadableError`, the `TypeError` a `fetch` of its blob: url rejects with, or an `<img>` load
 * error (an Error caused by the element's `error` Event). Any other `TypeError` is a bug in the code
 * reading the file, not the file, and keeps its own error path.
 */
export function isReadFailure(e: unknown) {
  if ((e as { name?: unknown } | null)?.name === 'NotReadableError') return true;
  if (e instanceof TypeError) return FETCH_FAILURE_MESSAGES.includes(e.message);
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
