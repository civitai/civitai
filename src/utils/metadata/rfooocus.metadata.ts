import { samplerMap } from '~/server/common/constants';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { findKeyForValue } from '~/utils/map-helpers';
import { createMetadataProcessor } from '~/utils/metadata/base.metadata';

const AIR_KEYS = ['ckpt_airs', 'lora_airs', 'embedding_airs'];

function cleanBadJson(str: string) {
  return str.replace(/\[NaN\]/g, '[]').replace(/\[Infinity\]/g, '[]');
}

export const rfooocusMetadataProcessor = createMetadataProcessor({
  canParse(exif) {
    return exif?.parameters?.includes('"software": "RuinedFooocus"');
  },
  parse: (exif) => {
    const {
      Prompt: prompt,
      Negative: negativePrompt,
      cfg: cfgScale,
      steps,
      seed,
      scheduler,
      denoise,
      width,
      height,
      base_model_hash,
      software,
      ...other
    } = JSON.parse(exif.parameters);

    const metadata: ImageMetaProps = {
      prompt,
      negativePrompt,
      cfgScale,
      steps,
      seed,
      sampler: other.sampler_name,
      denoise,
      width,
      height,
      Model: other.base_model_name.split('.').slice(0, -1).join('.'), // Remove the ext
      'Model hash': base_model_hash,
      software,
      other,
    };
    console.log(metadata);

    if (scheduler !== 'simple') metadata.scheduler = scheduler;

    // Map to automatic1111 terms for compatibility
    a1111Compatability(metadata);

    return metadata;
  },
  encode: (meta) => {
    return JSON.stringify({
      Prompt: meta.prompt,
      Negative: meta.negativePrompt,
      cfg: meta.cfgScale,
      steps: meta.steps,
      seed: meta.seed,
      scheduler: meta.scheduler ?? 'simple',
      denoise: meta.denoise,
      width: meta.width,
      height: meta.height,
      base_model_hash: meta['Model hash'],
      software: meta.software,
      ...(meta.other ?? {}),
    });
  },
});

function a1111Compatability(metadata: ImageMetaProps) {
  // Sampler name
  const samplerName = metadata.sampler;
  let a1111sampler: string | undefined;
  if (metadata.scheduler == 'karras') {
    a1111sampler = findKeyForValue(samplerMap, samplerName + '_karras');
  }
  if (!a1111sampler) a1111sampler = findKeyForValue(samplerMap, samplerName);
  if (a1111sampler) metadata.sampler = a1111sampler;
}
