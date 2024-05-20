import { unescape } from 'lodash-es';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { createMetadataProcessor, SDResource } from '~/utils/metadata/base.metadata';
import { parseAIR } from '~/utils/string-helpers';

type CivitaiResource = {
  weight?: number;
  air?: string;
  modelVersionId?: number;
  type?: string;
  versionName?: string;
  modelName?: string;
};

// #region [helpers]
const hashesRegex = /, Hashes:\s*({[^}]+})/;
const civitaiResources = /, Civitai resources:\s*(.+)/;
const badExtensionKeys = ['Resources: ', 'Hashed prompt: ', 'Hashed Negative prompt: '];
const templateKeys = ['Template: ', 'Negative Template: '] as const;
const automaticExtraNetsRegex = /<(lora|hypernet):([a-zA-Z0-9_\.\-]+):([0-9.]+)>/g;
const automaticNameHash = /([a-zA-Z0-9_\.]+)\(([a-zA-Z0-9]+)\)/;
const automaticSDKeyMap = new Map<string, string>([
  ['Seed', 'seed'],
  ['CFG scale', 'cfgScale'],
  ['Sampler', 'sampler'],
  ['Steps', 'steps'],
  ['Clip skip', 'clipSkip'],
]);
const getSDKey = (key: string) => automaticSDKeyMap.get(key.trim()) ?? key.trim();
const decoder = new TextDecoder('utf-16le');
const automaticSDEncodeMap = new Map<keyof ImageMetaProps, string>(
  Array.from(automaticSDKeyMap, (a) => a.reverse()) as Iterable<readonly [string, string]>
);
const excludedKeys = [
  'hashes',
  'civitaiResources',
  'scheduler',
  'vaes',
  'additionalResources',
  'comfy',
  'upscalers',
  'models',
  'controlNets',
  'denoise',
  'other',
  'external',
];
function isPartialDate(date: string) {
  return date.length === 14 && date[11] === 'T';
}
function parseDetailsLine(line: string | undefined): Record<string, any> {
  const result: Record<string, any> = {};
  if (!line) return result;
  let currentKey = '';
  let currentValue = '';
  let insideQuotes = false;
  let insideDate = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes) {
        result[currentKey] = parseDetailsLine(currentValue.trim());
        currentKey = '';
      }
      insideQuotes = !insideQuotes;
    } else if (char === ':' && !insideQuotes && !insideDate) {
      if (isPartialDate(currentValue)) insideDate = true;
      else {
        currentKey = getSDKey(currentValue.trim());
        currentValue = '';
      }
    } else if (char === ',' && !insideQuotes) {
      if (insideDate) insideDate = false;
      if (currentKey) result[currentKey] = currentValue.trim();
      currentKey = '';
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  if (currentKey) result[currentKey] = currentValue.trim();

  return result;
}

/**
 * Swap the byte order of a Uint8Array from big-endian to little-endian.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns A new Uint8Array with little-endian byte order.
 */
function swapByteOrder(buffer: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped;
}

/**
 * Remove Unicode header bytes if present.
 * @param buffer - The input Uint8Array.
 * @returns A new Uint8Array without BOM or header bytes.
 */
const unicodeHeader = new Uint8Array([85, 78, 73, 67, 79, 68, 69, 0]);
function removeUnicodeHeader(buffer: Uint8Array): Uint8Array {
  if (buffer.length < unicodeHeader.length) return buffer;

  // Check for BOM (Byte Order Mark) for big-endian UTF-16 (0xFEFF) and remove it if present
  for (let i = 0; i < unicodeHeader.length; i++) {
    if (buffer[i] !== unicodeHeader[i]) return buffer;
  }
  return buffer.slice(unicodeHeader.length);
}

/**
 * Decode a big-endian UTF-16 (Unicode) encoded buffer to a string.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns The decoded string.
 */
function decodeBigEndianUTF16(buffer: Uint8Array): string {
  // Remove BOM or unwanted header bytes if present
  const bufferWithoutBOM = removeUnicodeHeader(buffer);
  // Swap the byte order from big-endian to little-endian
  const littleEndianBuffer = swapByteOrder(bufferWithoutBOM);
  // Use TextDecoder to decode the little-endian buffer
  return decoder.decode(littleEndianBuffer);
}

// #endregion

export const automaticMetadataProcessor = createMetadataProcessor({
  canParse(exif) {
    let generationDetails = null;
    if (exif?.parameters) {
      generationDetails = exif.parameters;
    } else if (exif?.userComment) {
      generationDetails = decodeBigEndianUTF16(exif.userComment);
    }

    if (generationDetails) {
      exif.generationDetails = generationDetails;
      return generationDetails.includes('Steps: ');
    }
    return false;
  },
  parse(exif) {
    const metadata: ImageMetaProps = {};
    const generationDetails = exif.generationDetails as string;

    if (!generationDetails) return metadata;
    const metaLines = generationDetails.split('\n').filter((line) => line.trim() !== '');

    // Remove templates
    for (const key of templateKeys) {
      const templateLineIndex = metaLines.findIndex((line) => line.startsWith(key));
      if (templateLineIndex === -1) continue;
      metaLines.splice(templateLineIndex, 1);

      // Remove all lines until we hit a new key `[\w\s]+: `
      while (
        templateLineIndex < metaLines.length &&
        !/[\w\s]+: /.test(metaLines[templateLineIndex])
      ) {
        metaLines.splice(templateLineIndex, 1);
      }
    }

    let detailsLine = metaLines.find((line) => line.startsWith('Steps: '));
    // Strip it from the meta lines
    if (detailsLine) metaLines.splice(metaLines.indexOf(detailsLine), 1);
    // Remove meta keys I wish I hadn't made... :(
    for (const key of badExtensionKeys) {
      if (!detailsLine?.includes(key)) continue;
      detailsLine = detailsLine.split(key)[0];
    }

    // Extract Hashes
    const hashes = detailsLine?.match(hashesRegex)?.[1];
    if (hashes && detailsLine) {
      metadata.hashes = JSON.parse(hashes);
      detailsLine = detailsLine.replace(hashesRegex, '');
    }

    // Extract Civitai Resources
    const civitaiResourcesMatch = detailsLine?.match(civitaiResources)?.[1];
    if (civitaiResourcesMatch && detailsLine) {
      metadata.civitaiResources = JSON.parse(civitaiResourcesMatch);
      for (const resource of metadata.civitaiResources as CivitaiResource[]) {
        delete resource.modelName;
        delete resource.versionName;
        if (!resource.air) continue;
        const { version, type } = parseAIR(resource.air);
        resource.modelVersionId = version;
        resource.type = type;
        delete resource.air;
      }
      detailsLine = detailsLine.replace(civitaiResources, '');
    }

    // Extract fine details
    const details = parseDetailsLine(detailsLine);
    for (const [k, v] of Object.entries(details)) {
      const key = automaticSDKeyMap.get(k) ?? k;
      if (excludedKeys.includes(key)) continue;
      metadata[key] = v;
    }

    // Extract prompts
    const [prompt, ...negativePrompt] = metaLines
      .join('\n')
      .split('Negative prompt:')
      .map((x) => x.trim());
    metadata.prompt = prompt;
    metadata.negativePrompt = negativePrompt.join(' ').trim();

    // Extract resources
    const extranets = [...prompt.matchAll(automaticExtraNetsRegex)];
    const resources: SDResource[] = extranets.map(([, type, name, weight]) => ({
      type,
      name,
      weight: parseFloat(weight),
    }));

    // Extract Lora hashes
    if (metadata['Lora hashes']) {
      if (!metadata.hashes) metadata.hashes = {};
      for (const [name, hash] of Object.entries(metadata['Lora hashes'])) {
        metadata.hashes[`lora:${name}`] = hash;
        const resource = resources.find((r) => r.name === name);
        if (resource) resource.hash = hash;
        else resources.push({ type: 'lora', name, hash });
      }
      delete metadata['Lora hashes'];
    }

    // Extract VAE
    if (metadata['VAE hash']) {
      if (!metadata.hashes) metadata.hashes = {};
      metadata.hashes['vae'] = metadata['VAE hash'] as string;
      delete metadata['VAE hash'];
    }

    // Extract Model hash
    if (metadata['Model'] && metadata['Model hash']) {
      if (!metadata.hashes) metadata.hashes = {};
      if (!metadata.hashes['model']) metadata.hashes['model'] = metadata['Model hash'] as string;

      resources.push({
        type: 'model',
        name: metadata['Model'] as string,
        hash: metadata['Model hash'] as string,
      });
    }

    // Extract hypernetwork details
    if (metadata['Hypernet'] && metadata['Hypernet strength'])
      resources.push({
        type: 'hypernet',
        name: metadata['Hypernet'] as string,
        weight: parseFloat(metadata['Hypernet strength'] as string),
      });

    if (metadata['AddNet Enabled'] === 'True') {
      let i = 1;
      while (true) {
        const fullname = metadata[`AddNet Model ${i}`] as string;
        if (!fullname) break;
        const [, name, hash] = fullname.match(automaticNameHash) ?? [];

        resources.push({
          type: (metadata[`AddNet Module ${i}`] as string).toLowerCase(),
          name,
          hash,
          weight: parseFloat(metadata[`AddNet Weight ${i}`] as string),
        });
        i++;
      }
    }

    metadata.resources = resources;

    return metadata;
  },
  encode({ prompt, negativePrompt, resources, steps, ...other }) {
    const lines = [prompt];
    if (negativePrompt) lines.push(`Negative prompt: ${negativePrompt}`);
    const fineDetails = [];
    if (steps) fineDetails.push(`Steps: ${steps}`);
    for (const [k, v] of Object.entries(other)) {
      const key = automaticSDEncodeMap.get(k) ?? k;
      if (excludedKeys.includes(key)) continue;
      fineDetails.push(`${key}: ${v}`);
    }
    if (fineDetails.length > 0) lines.push(fineDetails.join(', '));

    return lines.join('\n');
  },
});
