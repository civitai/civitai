import { ImageMetaProps } from '~/server/schema/image.schema';
import { SDResource, createMetadataProcessor } from '~/utils/metadata/base.metadata';
import { unescape } from 'lodash';

// #region [helpers]
const hashesRegex = /, Hashes:\s*({[^}]+})/;
const badExtensionKeys = ['Resources: ', 'Hashed prompt: ', 'Hashed Negative prompt: '];
const stripKeys = ['Template: ', 'Negative Template: '] as const;
const automaticExtraNetsRegex = /<(lora|hypernet):([a-zA-Z0-9_\.]+):([0-9.]+)>/g;
const automaticNameHash = /([a-zA-Z0-9_\.]+)\(([a-zA-Z0-9]+)\)/;
const automaticSDKeyMap = new Map<string, string>([
  ['Seed', 'seed'],
  ['CFG scale', 'cfgScale'],
  ['Sampler', 'sampler'],
  ['Steps', 'steps'],
  ['Clip skip', 'clipSkip'],
]);
const getSDKey = (key: string) => automaticSDKeyMap.get(key.trim()) ?? key.trim();
const decoder = new TextDecoder('utf-8');
const automaticSDEncodeMap = new Map<keyof ImageMetaProps, string>(
  Array.from(automaticSDKeyMap, (a) => a.reverse()) as Iterable<readonly [string, string]>
);
const excludedKeys = [
  'hashes',
  'scheduler',
  'vaes',
  'additionalResources',
  'comfy',
  'upscalers',
  'models',
  'controlNets',
  'denoise',
];
// #endregion

export const automaticMetadataProcessor = createMetadataProcessor({
  canParse(exif) {
    let generationDetails = null;
    if (exif?.userComment) {
      const p = document.createElement('p');
      generationDetails = decoder.decode(exif.userComment);
      // Any annoying hack to deal with weirdness in the meta
      p.innerHTML = generationDetails;
      p.remove();
      generationDetails = p.innerHTML;
    } else if (exif?.parameters) {
      generationDetails = exif.parameters;
    }

    if (generationDetails) {
      generationDetails = generationDetails.replace('UNICODE', '').replace(/�/g, '');
      generationDetails = unescape(generationDetails);
      exif.generationDetails = generationDetails;
      return generationDetails.includes('Steps: ');
    }
    return false;
  },
  parse(exif) {
    const metadata: ImageMetaProps = {};
    const generationDetails = exif.generationDetails as string;
    if (!generationDetails) return metadata;
    const metaLines = generationDetails.split('\n').filter((line) => {
      // filter out empty lines and any lines that start with a key we want to strip
      return line.trim() !== '' && !stripKeys.some((key) => line.startsWith(key));
    });

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

    // Extract fine details
    let currentKey = '';
    const parts = detailsLine?.split(':') ?? [];
    for (const part of parts) {
      const priorValueEnd = part.lastIndexOf(',');
      if (parts[parts.length - 1] === part) {
        metadata[currentKey] = part.trim().replace(',', '');
      } else if (priorValueEnd !== -1) {
        metadata[currentKey] = part.slice(0, priorValueEnd).trim();
        currentKey = getSDKey(part.slice(priorValueEnd + 1));
      } else currentKey = getSDKey(part);
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

    if (metadata['Model'] && metadata['Model hash']) {
      if (!metadata.hashes) metadata.hashes = {};
      if (!metadata.hashes['model']) metadata.hashes['model'] = metadata['Model hash'] as string;

      resources.push({
        type: 'model',
        name: metadata['Model'] as string,
        hash: metadata['Model hash'] as string,
      });
    }

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
