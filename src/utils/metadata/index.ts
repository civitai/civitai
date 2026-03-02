import ExifReader from 'exifreader';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { rfooocusMetadataProcessor } from '~/utils/metadata/rfooocus.metadata';
import { swarmUIMetadataProcessor } from '~/utils/metadata/swarmui.metadata';

const parsers = {
  automatic: automaticMetadataProcessor,
  swarmui: swarmUIMetadataProcessor,
  rfooocus: rfooocusMetadataProcessor,
  comfy: comfyMetadataProcessor,
};

export async function ExifParser(file: File | string) {
  let tags: ExifReader.Tags = {} as ExifReader.Tags;
  try {
    tags = await ExifReader.load(file, { includeUnknown: true });
  } catch (e) {
    console.error('failed to read exif data');
  }

  const exif = Object.entries(tags).reduce((acc, [key, value]) => {
    acc[key] = value.value;
    return acc;
  }, {} as Record<string, any>); //eslint-disable-line

  if (exif.UserComment) {
    // @ts-ignore - this is a hack to not have to rework our downstream code
    exif.userComment = Int32Array.from(exif.UserComment);
  }

  const [name, parser] = Object.entries(parsers).find(([name, x]) => x.canParse(exif)) ?? [];

  function parse() {
    try {
      return parser?.parse(exif);
    } catch (e) {
      console.error('Error parsing metadata', e);
    }
  }

  function encode(meta: ImageMetaProps) {
    try {
      return parser?.encode(meta) ?? '';
    } catch (e) {
      console.error('Error encoding metadata', e);
      return '';
    }
  }

  function isMadeOnSite() {
    if (!exif.Artist) return false;
    const artist = Array.isArray(exif.Artist) ? exif.Artist.join(', ') : exif.Artist;
    return artist === 'ai';
  }

  async function getMetadata() {
    try {
      const metadata = parse();
      const result = imageMetaSchema.safeParse(metadata ?? {});
      return result.success ? result.data : {};
    } catch (e) {
      console.error(e);
      return {};
    }
  }

  return { exif, parse, encode, getMetadata, isMadeOnSite };
}

export async function getMetadata(file: File | string) {
  const parser = await ExifParser(file);
  return parser.getMetadata();
}

export function encodeMetadata(meta: ImageMetaProps, type: keyof typeof parsers = 'automatic') {
  return parsers[type]?.encode(meta);
}

export const parsePromptMetadata = (generationDetails: string) => {
  return automaticMetadataProcessor.parse({ generationDetails });
};

// #region [clipboard utilities]
const CIVITAI_META_ATTR = 'data-civitai-metadata';

/** Copies metadata to clipboard with both text/plain (A1111 format) and text/html (lossless JSON) */
export async function copyMetadataToClipboard(meta: ImageMetaProps): Promise<boolean> {
  const textPlain = encodeMetadata(meta);
  const jsonMeta = JSON.stringify(meta);
  const escapedText = textPlain
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const textHtml = `<div ${CIVITAI_META_ATTR}="${encodeURIComponent(jsonMeta)}">${escapedText}</div>`;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([textPlain], { type: 'text/plain' }),
        'text/html': new Blob([textHtml], { type: 'text/html' }),
      }),
    ]);
    return true;
  } catch {
    // Fallback to text-only for older browsers
    try {
      await navigator.clipboard.writeText(textPlain);
      return true;
    } catch {
      return false;
    }
  }
}

/** Extracts structured Civitai metadata from clipboard HTML content */
export function extractCivitaiMetadata(html: string): Record<string, unknown> | null {
  const match = html.match(new RegExp(`${CIVITAI_META_ATTR}="([^"]*)"`));
  if (!match?.[1]) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}
// #endregion
