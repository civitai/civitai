import type { Generator, MetadataParser } from '@civitai/generation-metadata';
/* eslint-disable no-restricted-imports -- this adapter IS the sanctioned wrapper */
import {
  applyPlugins,
  createParserContext,
  defaultParsers,
  encodeMetadata as encodePackageMetadata,
  generationMetadataSchema,
  parseGenerationText,
} from '@civitai/generation-metadata';
/* eslint-enable no-restricted-imports */
import { civitai, readCivitaiMetadata } from '@civitai/generation-metadata/civitai';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { readVideoMetadata } from '~/utils/metadata/video-metadata';

const PLUGINS = [civitai()];
const videoParserSetup = applyPlugins(PLUGINS, defaultParsers);
const VIDEO_PARSERS: MetadataParser[] = videoParserSetup.parsers;
const VIDEO_PARSER_CONTEXT = createParserContext(videoParserSetup.context);

export const legacyTypeToGenerator = {
  automatic: 'automatic1111',
  swarmui: 'swarmui',
  rfooocus: 'ruinedfooocus',
  comfy: 'comfyui',
} as const satisfies Record<string, Generator>;
type LegacyParserType = keyof typeof legacyTypeToGenerator;

function createMetadataParser(exif: Record<string, unknown>) {
  let matchedParser: MetadataParser | undefined;
  let matchedState: unknown;
  for (const parser of VIDEO_PARSERS) {
    try {
      const state = parser.detect(exif, VIDEO_PARSER_CONTEXT);
      if (!state) continue;
      matchedParser = parser;
      matchedState = state;
      break;
    } catch {
      continue;
    }
  }

  function parse() {
    if (!matchedParser) return;
    try {
      const raw = matchedParser.parse(matchedState, VIDEO_PARSER_CONTEXT);
      const result = generationMetadataSchema.safeParse(raw);
      return result.success ? result.data : {};
    } catch (e) {
      console.error('Error parsing metadata', e);
    }
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

  return { parse, getMetadata };
}

export async function ExifParser(file: File | string) {
  const md = await readCivitaiMetadata(file);

  function parse() {
    return Object.keys(md.raw).length > 0 ? (md.raw as ImageMetaProps) : undefined;
  }

  function encode(meta: ImageMetaProps) {
    if (!md.generator) return '';
    return encodePackageMetadata(meta, md.generator, { plugins: PLUGINS });
  }

  function isMadeOnSite() {
    return md.civitai?.madeOnSite ?? false;
  }

  async function getMetadata() {
    const result = imageMetaSchema.safeParse(md.raw ?? {});
    return result.success ? result.data : {};
  }

  return { exif: md.exif, parse, encode, getMetadata, isMadeOnSite, media: md };
}

export async function VideoMetadataParser(file: Blob) {
  const exif = await readVideoMetadata(file);
  const { parse, getMetadata } = createMetadataParser(exif);
  return { exif, parse, getMetadata };
}

export async function getMetadata(file: File | string) {
  const parser = await ExifParser(file);
  return parser.getMetadata();
}

export function encodeMetadata(meta: ImageMetaProps, type: LegacyParserType = 'automatic') {
  return encodePackageMetadata(meta, legacyTypeToGenerator[type], { plugins: PLUGINS });
}

export const parsePromptMetadata = (generationDetails: string) => {
  const raw = parseGenerationText(generationDetails, { plugins: PLUGINS }).raw;
  const result = imageMetaSchema.safeParse(raw);
  return (result.success ? result.data : raw) as ImageMetaProps;
};

// #region [clipboard utilities]
const CIVITAI_META_ATTR = 'data-civitai-metadata';

/** Copies metadata to clipboard with both text/plain (A1111 format) and text/html (lossless JSON) */
export async function copyMetadataToClipboard(meta: ImageMetaProps): Promise<boolean> {
  const textPlain = encodeMetadata(meta);
  const jsonMeta = JSON.stringify(meta);
  const escapedText = textPlain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const textHtml = `<div ${CIVITAI_META_ATTR}="${encodeURIComponent(
    jsonMeta
  )}">${escapedText}</div>`;

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
