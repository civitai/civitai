import type { Generator } from '@civitai/generation-metadata';
/* eslint-disable no-restricted-imports -- this adapter IS the sanctioned wrapper */
import {
  encodeMetadata as encodePackageMetadata,
  parseGenerationText,
} from '@civitai/generation-metadata';
/* eslint-enable no-restricted-imports */
import { civitai, readCivitaiMetadata } from '@civitai/generation-metadata/civitai';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';

/**
 * Thin adapter over @civitai/generation-metadata, keeping this module's historical
 * surface so call sites don't all change at once. Parsing/encoding live in the
 * package (with the civitai plugin baked in); this file owns the app-only
 * pieces: imageMetaSchema re-validation (which also strips `extra` to the
 * app's shape) and the clipboard helpers.
 *
 * The `extra` stripping has a cost: the package's normalizeCivitaiGeneration
 * recovers on-site width/height from `raw.extra`, so rows stored through
 * getMetadata() can't use that recovery — take dimensions from the Image row,
 * which stores them anyway.
 */

const PLUGINS = [civitai()];

export const legacyTypeToGenerator = {
  automatic: 'automatic1111',
  swarmui: 'swarmui',
  rfooocus: 'ruinedfooocus',
  comfy: 'comfyui',
} as const satisfies Record<string, Generator>;
type LegacyParserType = keyof typeof legacyTypeToGenerator;

/**
 * `file` is a File/Blob or a URL string (http/data/blob) — local filesystem
 * paths were never part of this surface.
 *
 * `parse()` returns the raw bag unvalidated; `getMetadata()` re-validates via
 * imageMetaSchema, which also strips `extra` to the app's shape — call sites
 * that store meta depend on getMetadata's stripping, not parse's fidelity.
 */
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

  // `media` exposes the package's full envelope (incl. the plugin's normalized
  // view at `civitai.generation`) for call sites migrating past the legacy surface
  return { exif: md.exif, parse, encode, getMetadata, isMadeOnSite, media: md };
}

export async function getMetadata(file: File | string) {
  const parser = await ExifParser(file);
  return parser.getMetadata();
}

export function encodeMetadata(meta: ImageMetaProps, type: LegacyParserType = 'automatic') {
  return encodePackageMetadata(meta, legacyTypeToGenerator[type], { plugins: PLUGINS });
}

export const parsePromptMetadata = (generationDetails: string) => {
  // note: the package validates on parse, so numeric fields come back as
  // numbers where the old in-app parser returned raw strings
  const raw = parseGenerationText(generationDetails, { plugins: PLUGINS }).raw;
  // same imageMetaSchema pass as getMetadata(), so a pasted-then-stored meta
  // goes through the identical extra-stripping as an uploaded file's
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
