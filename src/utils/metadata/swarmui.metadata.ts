import { samplerMap } from '~/server/common/constants';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { findKeyForValue } from '~/utils/map-helpers';
import { createMetadataProcessor, setGlobalValue } from '~/utils/metadata/base.metadata';
import { removeEmpty } from '~/utils/object-helpers';
import { numericStringArray } from '~/utils/zod-helpers';

function cleanBadJson(str: string) {
  return str
    .replace(/\[NaN\]/g, '[]')
    .replace(/NaN/g, '0')
    .replace(/\[Infinity\]/g, '[]');
}

export const swarmUIMetadataProcessor = createMetadataProcessor({
  canParse: (exif) => {
    const params = exif.generationDetails ?? exif.parameters;
    if (!params) return false;
    if (!params.includes('sui_image_params')) return false;

    return true;
  },
  parse: (exif) => {
    const params = exif.generationDetails ?? exif.parameters;
    const generationDetails = JSON.parse(cleanBadJson(params as string))
      ?.sui_image_params as Record<string, any>;
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
      resources: getResources(generationDetails),
    });

    a1111Compatability(metadata);

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
    });
  },
});

function a1111Compatability(metadata: ImageMetaProps) {
  // Sampler name
  const samplerName = metadata.sampler;
  metadata.originalSampler = metadata.sampler;
  let a1111sampler: string | undefined;
  if (metadata.scheduler == 'karras') {
    a1111sampler = findKeyForValue(samplerMap, samplerName + '_karras');
  }
  if (!a1111sampler) a1111sampler = findKeyForValue(samplerMap, samplerName);
  if (a1111sampler) metadata.sampler = a1111sampler;
}

function getResources(generationDetails: Record<string, any>) {
  const resources: { name: string; weight?: number; type: string }[] = [];
  if (generationDetails.model) resources.push({ type: 'model', name: generationDetails.model });
  try {
    const loras: string[] = generationDetails.loras ?? [];
    const weights = numericStringArray().parse(generationDetails.loraweights ?? []);

    resources.push(...loras.map((name, i) => ({ name, type: 'lora', weight: weights[i] })));
  } catch {}

  return resources;
}
