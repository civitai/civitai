import type { ImageMetaProps } from '~/server/schema/image.schema';
import {
  a1111Compatibility,
  createMetadataProcessor,
  setGlobalValue,
} from '~/utils/metadata/base.metadata';
import { removeEmpty } from '~/utils/object-helpers';

function cleanBadJson(str: string) {
  return str
    .replace(/\[NaN\]/g, '[]')
    .replace(/\bNaN\b/g, '0')
    .replace(/\[Infinity\]/g, '[]');
}

type SwarmUiMetadata = {
  sui_image_params?: Record<string, any>;
  sui_models?: { name: string; param: string; hash: string; weight?: number }[];
};

// https://github.com/mcmonkeyprojects/SwarmUI/blob/master/docs/Image%20Metadata%20Format.md#sui_models
export const swarmUIMetadataProcessor = createMetadataProcessor({
  canParse: (exif) => {
    const params = exif.generationDetails ?? exif.parameters;
    if (!params) return false;
    if (!params.includes('sui_image_params')) return false;

    return true;
  },
  parse: (exif) => {
    const params = exif.generationDetails ?? exif.parameters;
    const parsed: SwarmUiMetadata = JSON.parse(cleanBadJson(params as string));
    const generationDetails = parsed.sui_image_params ?? {};

    setGlobalValue('nodeJson', generationDetails);

    const metadata: Record<string, any> = removeEmpty({
      prompt: generationDetails.prompt,
      negativePrompt: generationDetails.negativeprompt,
      cfgScale: generationDetails.cfgscale,
      steps: generationDetails.steps,
      seed: generationDetails.seed,
      width: generationDetails.width,
      height: generationDetails.height,
      sampler: generationDetails.sampler,
      scheduler: generationDetails.scheduler,
      version: generationDetails.swarmVersion,
      Model: generationDetails.model,
      resources: getResources(parsed),
    });

    a1111Compatibility(metadata, { preserveOriginal: true });

    return metadata;
  },
  encode: (meta) => {
    return JSON.stringify({
      sui_image_params: {
        prompt: meta.prompt,
        negativeprompt: meta.negativePrompt,
        cfgscale: meta.cfgScale,
        steps: meta.steps,
        seed: meta.seed,
        width: meta.width,
        height: meta.height,
        aspectratio: 'custom',
        sampler: meta.originalSampler ?? meta.sampler,
        scheduler: meta.scheduler,
        model: meta.Model,
        swarmVersion: meta.version,
      },
      sui_models: meta.resources?.map(({ type, name, weight, hash }) => ({
        name: name!,
        weight: weight,
        hash: hash!,
        param: type,
      })),
    } satisfies SwarmUiMetadata);
  },
});

function getResources({ sui_image_params = {}, sui_models = [] }: SwarmUiMetadata) {
  const loras: string[] = sui_image_params.loras ?? [];
  const resources = sui_models.map(({ name, param, hash, weight }) => {
    const nameWithoutExtension = name.split('.')[0];
    let type = param;
    if (type === 'loras') type = 'lora';
    const loraIndex = loras.findIndex((lora) => lora === nameWithoutExtension);
    return removeEmpty({
      name: nameWithoutExtension,
      type,
      hash: hash?.replace('0x', '').slice(0, 12),
      weight:
        weight ?? (loraIndex > -1 ? Number(sui_image_params.loraweights[loraIndex]) : undefined),
    });
  });

  return resources;
}
