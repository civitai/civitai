/** How long a pick's probe read may take before the pick is treated as readable. */
export const UNREADABLE_PROBE_TIMEOUT_MS = 3_000;

/**
 * Some Android photo pickers (opened by a file input whose `accept` lists only images) hand the page
 * a File whose bytes no API can read: every read rejects with `NotReadableError`. The same photo
 * chosen through the Files app reads fine, so the remedy is to offer that chooser instead.
 *
 * Only a `NotReadableError` rejection counts as unreadable. A read that has not settled after
 * `timeoutMs` (a cloud-only photo the provider is still downloading) counts as readable: the
 * pick goes on to the upload pipeline, whose own steps are time-bounded.
 */
export async function probeUnreadablePick(
  file: File,
  timeoutMs = UNREADABLE_PROBE_TIMEOUT_MS
): Promise<DOMException | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  // Started inside a promise so a read that throws rather than rejects is handled the same way.
  const read = Promise.resolve()
    .then(() => file.slice(0, 16).arrayBuffer())
    .then(
      () => undefined,
      (e) =>
        (e as { name?: unknown } | null)?.name === 'NotReadableError'
          ? (e as DOMException)
          : undefined
    );
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Splits picked files into those that can be read and those the picker made unreadable. */
export async function splitUnreadablePicks(files: File[]) {
  const probed = await Promise.all(
    files.map(async (file) => ({ file, error: await probeUnreadablePick(file) }))
  );
  return {
    readable: probed.filter((p) => !p.error).map((p) => p.file),
    unreadable: probed.filter(
      (p): p is { file: File; error: DOMException } => p.error !== undefined
    ),
  };
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
