import type { Media } from '$lib/data/trainingModels';

/** One row per accepted file kind — every ext↔media↔mime question answers from here, because the
 *  Data step's zip import and the run detail's zip download must round-trip byte-compatible names. */
const KINDS: { ext: string; media: Media; mime: string }[] = [
  { ext: 'png', media: 'image', mime: 'image/png' },
  { ext: 'jpg', media: 'image', mime: 'image/jpeg' },
  { ext: 'jpeg', media: 'image', mime: 'image/jpeg' },
  { ext: 'webp', media: 'image', mime: 'image/webp' },
  { ext: 'gif', media: 'image', mime: 'image/gif' },
  { ext: 'bmp', media: 'image', mime: 'image/bmp' },
  { ext: 'mp4', media: 'video', mime: 'video/mp4' },
  { ext: 'webm', media: 'video', mime: 'video/webm' },
  { ext: 'mov', media: 'video', mime: 'video/quicktime' },
  { ext: 'mkv', media: 'video', mime: 'video/x-matroska' },
  { ext: 'mp3', media: 'audio', mime: 'audio/mpeg' },
  { ext: 'wav', media: 'audio', mime: 'audio/wav' },
  { ext: 'flac', media: 'audio', mime: 'audio/flac' },
  { ext: 'ogg', media: 'audio', mime: 'audio/ogg' },
  { ext: 'm4a', media: 'audio', mime: 'audio/mp4' },
];

export function mediaOfExt(ext: string): Media | undefined {
  const lower = ext.toLowerCase();
  return KINDS.find((k) => k.ext === lower)?.media;
}

export function mimeOfExt(ext: string): string | undefined {
  const lower = ext.toLowerCase();
  return KINDS.find((k) => k.ext === lower)?.mime;
}

/** First row's ext for a mime — `jpeg` never wins over `jpg` because `jpg` is listed first. */
export function extOfMime(mime: string): string | undefined {
  const lower = mime.toLowerCase();
  return KINDS.find((k) => k.mime === lower)?.ext;
}

/** The file extension a blob AIR/URL carries (query stripped), lowercase; undefined when none. */
export function extOfAir(air: string): string | undefined {
  const path = air.split('?')[0]!;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return /^\w+$/.test(ext) ? ext : undefined;
}
