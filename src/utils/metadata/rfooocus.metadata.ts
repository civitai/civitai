import type { ImageMetaProps } from '~/server/schema/image.schema';
import { a1111Compatibility, createMetadataProcessor } from '~/utils/metadata/base.metadata';

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

    if (scheduler !== 'simple') metadata.scheduler = scheduler;

    // Map to automatic1111 terms for compatibility
    a1111Compatibility(metadata);

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


