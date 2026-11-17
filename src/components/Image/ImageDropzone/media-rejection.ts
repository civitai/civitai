import type { FileRejection } from '@mantine/dropzone';
import { formatBytes } from '~/utils/number-helpers';

type Limits = {
  extensions: string[];
  video?: { maxSize: number; seconds: number; maxDimension: number };
  maxSize?: number;
  maxFiles?: number;
};

/** The message for the first rejection. */
export function describeMediaRejection(
  rejections: FileRejection[],
  { extensions, video, maxSize, maxFiles }: Limits
) {
  const [first] = rejections;
  if (!first) return undefined;
  const codes = first.errors.map((e) => e.code);
  const name = first.file.name;
  let text: string;
  if (codes.includes('file-invalid-type')) {
    text = `${name}: unsupported file type. Accepted: ${extensions.join(', ')}.`;
    if (video)
      text += ` Videos can be up to ${video.seconds} seconds, ${
        video.maxDimension
      }px, and ${formatBytes(video.maxSize)}.`;
  } else if (codes.includes('file-too-large')) {
    text = maxSize
      ? `${name} is ${formatBytes(first.file.size)}. The limit is ${formatBytes(maxSize)}.`
      : `${name} is too large.`;
  } else if (codes.includes('too-many-files')) {
    text = `Too many files${maxFiles ? `. Add up to ${maxFiles} at a time` : ''}.`;
  } else {
    text = `${name}: ${first.errors.map((e) => e.message).join(' ')}`;
  }
  return rejections.length > 1 ? `${text} (${rejections.length - 1} more not added.)` : text;
}
