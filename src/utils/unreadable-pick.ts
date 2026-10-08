/**
 * Some Android photo pickers (opened by a file input whose `accept` lists only images) hand the page
 * a File whose bytes no API can read: every read rejects with `NotReadableError`. The same photo
 * chosen through the Files app reads fine, so the remedy is to offer that chooser instead.
 */
export async function probeUnreadablePick(file: File): Promise<DOMException | undefined> {
  try {
    await file.slice(0, 16).arrayBuffer();
    return undefined;
  } catch (e) {
    return (e as { name?: unknown } | null)?.name === 'NotReadableError'
      ? (e as DOMException)
      : undefined;
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

export const UNREADABLE_PICK_MESSAGE =
  "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";

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
