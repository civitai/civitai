import { samplerMap } from '~/server/common/constants';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { findKeyForValue } from '~/utils/map-helpers';
import { createMetadataProcessor } from '~/utils/metadata/base.metadata';

export const comfyMetadataProcessor = createMetadataProcessor({
  canParse: (exif) => exif.prompt && exif.workflow,
  parse: (exif) => {
    console.log(exif);
    const data = JSON.parse(exif.prompt as string) as Record<string, ComfyNode>;
    const samplerNodes: SamplerNode[] = [];
    const models: string[] = [];
    const upscalers: string[] = [];
    const vaes: string[] = [];
    const controlNets: string[] = [];
    const additionalResources: AdditionalResource[] = [];
    for (const node of Object.values(data)) {
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value)) node.inputs[key] = data[value[0]];
      }

      if (node.class_type == 'KSamplerAdvanced') {
        const simplifiedNode = { ...node.inputs };

        simplifiedNode.steps = getNumberValue(simplifiedNode.steps as ComfyNumber);
        simplifiedNode.cfg = getNumberValue(simplifiedNode.cfg as ComfyNumber);

        samplerNodes.push(simplifiedNode as SamplerNode);
      }

      if (node.class_type == 'KSampler') samplerNodes.push(node.inputs as SamplerNode);

      if (node.class_type == 'LoraLoader') {
        // Ignore lora nodes with strength 0
        const strength = node.inputs.strength_model as number;
        if (strength < 0.001 && strength > -0.001) continue;

        additionalResources.push({
          name: node.inputs.lora_name as string,
          type: 'lora',
          strength,
          strengthClip: node.inputs.strength_clip as number,
        });
      }

      if (node.class_type == 'CheckpointLoaderSimple') models.push(node.inputs.ckpt_name as string);

      if (node.class_type == 'UpscaleModelLoader') upscalers.push(node.inputs.model_name as string);

      if (node.class_type == 'VAELoader') vaes.push(node.inputs.vae_name as string);

      if (node.class_type == 'ControlNetLoader')
        controlNets.push(node.inputs.control_net_name as string);
    }

    const initialSamplerNode =
      samplerNodes.find((x) => x.latent_image.class_type == 'EmptyLatentImage') ?? samplerNodes[0];

    const metadata: ImageMetaProps = {
      prompt: getPromptText(initialSamplerNode.positive),
      negativePrompt: getPromptText(initialSamplerNode.negative),
      cfgScale: initialSamplerNode.cfg,
      steps: initialSamplerNode.steps,
      seed: initialSamplerNode.seed,
      sampler: initialSamplerNode.sampler_name,
      scheduler: initialSamplerNode.scheduler,
      denoise: initialSamplerNode.denoise,
      width: initialSamplerNode.latent_image.inputs.width,
      height: initialSamplerNode.latent_image.inputs.height,
      models,
      upscalers,
      vaes,
      additionalResources,
      controlNets,
      comfy: {
        prompt: JSON.parse(exif.prompt),
        workflow: JSON.parse(exif.workflow),
      },
    };

    // Handle control net apply
    if (initialSamplerNode.positive.class_type === 'ControlNetApply') {
      const conditioningNode = initialSamplerNode.positive.inputs.conditioning as ComfyNode;
      metadata.prompt = conditioningNode.inputs.text as string;
    }

    // Map to automatic1111 terms for compatibility
    a1111Compatability(metadata);

    return metadata;
  },
  encode: ({ comfy }) => {
    return JSON.stringify((comfy as any).workflow);
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

  // Model
  const models = metadata.models as string[];
  if (models.length > 0) {
    metadata.Model = models[0].replace(/\.[^/.]+$/, '');
  }
}

function getPromptText(node: ComfyNode) {
  if (node.inputs?.text) return node.inputs.text as string;
  if (node.inputs?.text_g) {
    if (!node.inputs?.text_l || node.inputs?.text_l === node.inputs?.text_g)
      return node.inputs.text_g as string;
    return `${node.inputs.text_g}, ${node.inputs.text_l}`;
  }
  return '';
}

type ComfyNumber = ComfyNode | number;
function getNumberValue(input: ComfyNumber) {
  if (typeof input === 'number') return input;
  return input.inputs.Value as number;
}

// #region [types]
type ComfyNode = {
  inputs: Record<string, number | string | Array<string | number> | ComfyNode>;
  class_type: string;
};

type SamplerNode = {
  seed: number;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  denoise: number;
  model: ComfyNode;
  positive: ComfyNode;
  negative: ComfyNode;
  latent_image: ComfyNode;
};

type AdditionalResource = {
  name: string;
  type: string;
  strength: number;
  strengthClip: number;
};
// #endregion
