import { FileWithPath } from '@mantine/dropzone';
import exifr from 'exifr';
import { ImageMetaProps, imageMetaSchema } from '~/server/schema/image.schema';

export async function getMetadata(file: FileWithPath) {
  let exif: any;
  try {
    exif = await exifr.parse(file, {
      userComment: true,
    });
  } catch (e: any) {
    return {};
  }
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

  const metadata = parseMetadata(generationDetails);
  const result = imageMetaSchema.safeParse(metadata);
  return result.success ? result.data : {};
}

// #region [infra]
function parseMetadata(meta: string): Record<string, unknown> {
  if (!meta) return {};

  const { parse } = parsers.find((x) => x.canHandle(meta)) ?? {};
  if (!parse) return {};

  return parse(meta);
}

type MetadataParser = {
  canHandle: (meta: string) => boolean;
  parse: (meta: string) => ImageMetaProps;
};

function createMetadataParser(
  canHandle: MetadataParser['canHandle'],
  parse: MetadataParser['parse']
): MetadataParser {
  return {
    canHandle,
    parse,
  };
}

const decoder = new TextDecoder('utf-8');
// #endregion

// #region [parsers]
const automaticSDKeyMap = new Map<string, keyof ImageMetaProps>([
  ['Seed', 'seed'],
  ['CFG scale', 'cfgScale'],
  ['Sampler', 'sampler'],
  ['Steps', 'steps'],
]);
const automaticSDParser = createMetadataParser(
  (meta: string) => meta.includes('Steps: '),
  (meta: string) => {
    const metadata: ImageMetaProps = {};
    if (!meta) return metadata;
    const metaLines = meta.split('\n');
    const fineDetails =
      metaLines
        .pop()
        ?.split(',')
        .map((x) => x.split(':')) ?? [];
    for (const [k, v] of fineDetails) {
      const propKey = automaticSDKeyMap.get(k.trim()) ?? k.trim();
      metadata[propKey] = v.trim();
    }

    const [prompt, negativePrompt] = metaLines
      .join('\n')
      .split('Negative prompt:')
      .map((x) => x.trim());
    metadata.prompt = prompt;
    metadata.negativePrompt = negativePrompt;
    return metadata;
  }
);
const parsers = [automaticSDParser];
// #endregion

// #region [encoders]
export function encodeMetadata(
  metadata: ImageMetaProps,
  encoder: keyof typeof encoders = 'automatic1111'
) {
  return encoders[encoder](metadata);
}

const automaticSDEncodeMap = new Map<keyof ImageMetaProps, string>(
  Array.from(automaticSDKeyMap, (a) => a.reverse()) as Iterable<readonly [string, string]>
);
function automaticEncoder({ prompt, negativePrompt, ...other }: ImageMetaProps) {
  const lines = [prompt];
  if (negativePrompt) lines.push(`Negative prompt: ${negativePrompt}`);
  const fineDetails = [];
  for (const [k, v] of Object.entries(other)) {
    const key = automaticSDEncodeMap.get(k) ?? k;
    fineDetails.push(`${key}: ${v}`);
  }
  if (fineDetails.length > 0) lines.push(fineDetails.join(', '));

  return lines.join('\n');
}

const encoders = {
  automatic1111: automaticEncoder,
};
// #endregion
