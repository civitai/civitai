import { samplerMap } from '~/server/common/constants';
import type {
  ComfyMetaSchema,
  ImageMetaProps,
  CivitaiResource,
} from '~/server/schema/image.schema';
import { findKeyForValue } from '~/utils/map-helpers';
import { createMetadataProcessor, setGlobalValue } from '~/utils/metadata/base.metadata';
import { fromJson } from '../json-helpers';
import { decodeUserComment } from '~/utils/encoding-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { removeEmpty } from '~/utils/object-helpers';

const AIR_KEYS = ['ckpt_airs', 'lora_airs', 'embedding_airs'];

function cleanBadJson(str: string) {
  return str
    .replace(/\[NaN\]/g, '[]')
    .replace(/NaN/g, '0')
    .replace(/\[Infinity\]/g, '[]');
}

export const comfyMetadataProcessor = createMetadataProcessor({
  canParse: (exif) => {
    const isStandardComfy = exif.prompt || exif.workflow;
    if (isStandardComfy) return true;

    // webp format
    const isWebpComfy = exif?.Model?.[0]?.startsWith('prompt:');
    if (isWebpComfy) {
      const comfyJson = exif.Model[0].replace(/^prompt:/, '');

      exif.prompt = comfyJson;
      exif.workflow = comfyJson;
      if (exif.userComment) {
        const extrasJson = decodeUserComment(exif.userComment);
        try {
          exif.extraMetadata = JSON.parse(extrasJson)?.extraMetadata;
          // Fix for bad json
          if (typeof exif.extraMetadata === 'string')
            exif.extraMetadata = JSON.parse(exif.extraMetadata);
        } catch {}
      }
      return true;
    }

    // TODO: remove someday...
    // Check for our ugly hack
    let generationDetails = null;
    if (exif?.parameters) {
      generationDetails = exif.parameters;
    } else if (exif?.userComment) {
      generationDetails = decodeUserComment(exif.userComment);
    }

    if (generationDetails) {
      try {
        const details = JSON.parse(generationDetails);
        const { extra, extraMetadata, ...workflow } = details;
        if (typeof extraMetadata === 'string') {
          try {
            exif.extraMetadata = JSON.parse(extraMetadata);
          } catch {}
        }
        if (details.extra) {
          exif.prompt = JSON.stringify(workflow);
          exif.workflow = generationDetails;
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    return false;
  },
  parse: (exif) => {
    const prompt = JSON.parse(cleanBadJson(exif.prompt as string)) as Record<string, ComfyNode>;
    setGlobalValue('nodeJson', prompt);
    const samplerNodes: SamplerNode[] = [];
    const models: string[] = [];
    const upscalers: string[] = [];
    const vaes: string[] = [];
    const controlNets: string[] = [];
    const additionalResources: AdditionalResource[] = [];
    const nodes = Object.values(prompt);
    for (const node of nodes) {
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value)) node.inputs[key] = prompt[value[0]];
      }

      if (node.class_type == 'KSamplerAdvanced') {
        const simplifiedNode = { ...node.inputs };

        simplifiedNode.steps = getNumberValue(simplifiedNode.steps as ComfyNumber);
        simplifiedNode.cfg = getNumberValue(simplifiedNode.cfg as ComfyNumber);

        samplerNodes.push(simplifiedNode as SamplerNode);
      }

      if (node.class_type == 'KSampler') samplerNodes.push(node.inputs as SamplerNode);
      if (node.class_type == 'KSampler (Efficient)') samplerNodes.push(node.inputs as SamplerNode);

      if (['LoraLoader', 'LoraLoaderModelOnly'].includes(node.class_type)) {
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
    const customAdvancedSampler = nodes.find((x) => x.class_type == 'SamplerCustomAdvanced');

    const workflow = exif.workflow ? (JSON.parse(exif.workflow as string) as any) : undefined;
    const versionIds: number[] = [];
    const modelIds: number[] = [];
    let isCivitComfy = workflow?.extra?.airs?.length > 0;
    if (workflow?.extra) {
      // Old AIR parsing
      for (const key of AIR_KEYS) {
        const airs = workflow.extra[key];
        if (!airs) continue;

        for (const air of airs) {
          const [modelId, versionId] = air.split('@');
          if (versionId) versionIds.push(parseInt(versionId));
          else if (modelId) modelIds.push(parseInt(modelId));
        }
      }
    }

    const metadata: ImageMetaProps = {
      models,
      upscalers,
      vaes,
      additionalResources,
      controlNets,
      versionIds,
      modelIds,
      // Converting to string to reduce bytes size
      // isCivitComfy to handle old generations when we weren't compliant
      comfy: isCivitComfy ? undefined : `{"prompt": ${exif.prompt}, "workflow": ${exif.workflow}}`,
    };
    if (exif.extraMetadata && typeof exif.extraMetadata === 'object' && exif.extraMetadata.prompt) {
      const {
        prompt,
        negativePrompt,
        cfgScale,
        steps,
        seed,
        sampler,
        denoise,
        workflowId,
        resources,
        ...extra
      } = exif.extraMetadata;
      metadata.prompt = prompt;
      metadata.negativePrompt = negativePrompt;
      metadata.cfgScale = cfgScale;
      metadata.steps = steps;
      metadata.seed = seed;
      metadata.sampler = sampler;
      metadata.denoise = denoise;
      metadata.workflow = workflowId;
      metadata.civitaiResources = resources.map((x: any) => {
        if (x.strength) {
          x.weight = x.strength;
          delete x.strength;
        }
        return x;
      });
      if (extra) metadata.extra = extra;
    } else if (customAdvancedSampler) {
      // Its fancy Flux...

      // Get Seed
      const seedNode = customAdvancedSampler.inputs.noise as ComfyNode;
      if (seedNode?.class_type === 'RandomNoise')
        metadata.seed = seedNode.inputs.noise_seed as number;

      // Get sampler
      const samplerNode = customAdvancedSampler.inputs.sampler as ComfyNode;
      if (samplerNode?.class_type === 'KSamplerSelect')
        metadata.sampler = samplerNode.inputs.sampler_name as string;
      else if (samplerNode?.class_type === 'ODESamplerSelect')
        metadata.sampler = samplerNode.inputs.solver as string;

      // Get Guidance
      const guidanceNode = customAdvancedSampler.inputs.guider as ComfyNode;
      processGuidance: if (guidanceNode?.class_type === 'BasicGuider') {
        // Get cfgScale
        const conditioningNode = guidanceNode.inputs.conditioning as ComfyNode;
        let textEncoderNode: ComfyNode | undefined;
        if (conditioningNode?.class_type === 'CLIPTextEncode') {
          textEncoderNode = conditioningNode;
        } else if (conditioningNode?.class_type === 'FluxGuidance') {
          textEncoderNode = conditioningNode.inputs.conditioning as ComfyNode;
          metadata.cfgScale = conditioningNode.inputs.guidance as number;
        }

        // Get prompt
        if (textEncoderNode?.class_type !== 'CLIPTextEncode') break processGuidance;
        if (typeof textEncoderNode.inputs.text === 'string') {
          metadata.prompt = textEncoderNode.inputs.text;
          break processGuidance;
        }

        // Get prompt from node
        const textNode = textEncoderNode.inputs.text as ComfyNode;
        if (textNode?.class_type === 'ImpactWildcardProcessor') {
          metadata.prompt = textNode.inputs.populated_text as string;
        } else if (textNode?.class_type === 'String Literal')
          metadata.prompt = textNode.inputs.string as string;
      }

      // Get steps
      const schedulerNode = customAdvancedSampler.inputs.sigmas as ComfyNode;
      if (schedulerNode?.class_type === 'BasicScheduler') {
        metadata.steps = schedulerNode.inputs.steps as number;
        metadata.scheduler = schedulerNode.inputs.scheduler as string;
        metadata.denoise = schedulerNode.inputs.denoise as number;
      }

      // Get dimensions
      const latentImageNode = customAdvancedSampler.inputs.latent_image as ComfyNode;
      if (latentImageNode?.class_type === 'EmptyLatentImage') {
        metadata.width = getNumberValue(latentImageNode.inputs.width as ComfyNumber, ['int']);
        metadata.height = getNumberValue(latentImageNode.inputs.height as ComfyNumber, ['int']);
      }
    } else {
      const initialSamplerNode =
        samplerNodes.find((x) => x.latent_image.class_type == 'EmptyLatentImage') ??
        samplerNodes[0];

      if (initialSamplerNode) {
        metadata.prompt = getPromptText(initialSamplerNode.positive, 'positive');
        metadata.negativePrompt = getPromptText(initialSamplerNode.negative, 'negative');
        metadata.cfgScale = initialSamplerNode.cfg;
        metadata.steps = initialSamplerNode.steps;
        metadata.seed = getNumberValue(initialSamplerNode.seed ?? initialSamplerNode.noise_seed, [
          'Value',
          'seed',
        ]);
        metadata.sampler = initialSamplerNode.sampler_name;
        metadata.scheduler = initialSamplerNode.scheduler;
        metadata.denoise = initialSamplerNode.denoise;
        metadata.width = initialSamplerNode.latent_image.inputs.width;
        metadata.height = initialSamplerNode.latent_image.inputs.height;
      }
      if (exif.extraMetadata) {
        metadata.extra = exif.extraMetadata;
      }
    }

    // Get airs from parsed resources
    const workflowAirs = [
      ...models,
      ...upscalers,
      ...vaes,
      ...additionalResources.map((x) => x.name),
    ].filter((x) => x.startsWith('urn:air:'));
    if (workflowAirs.length > 0) {
      workflow.extra = { airs: workflowAirs };
      isCivitComfy = true;
    }

    if (isCivitComfy) {
      const civitaiResources = (metadata.civitaiResources ?? []) as CivitaiResource[];

      for (const air of workflow.extra.airs) {
        const { version, type } = parseAIR(air);
        const resource: CivitaiResource = {
          modelVersionId: version,
          type,
        };
        const weight = additionalResources.find((x) => x.name === air)?.strength;
        if (weight) resource.weight = weight;
        const index = civitaiResources.findIndex(
          (x) => x.modelVersionId === resource.modelVersionId
        );
        if (index > -1) civitaiResources[index] = resource;
        else civitaiResources.push(resource);
        metadata.civitaiResources = civitaiResources;

        const additionalResourceIndex = additionalResources.findIndex((x) => x.name === air);
        if (additionalResourceIndex > -1)
          metadata.additionalResources?.splice(additionalResourceIndex, 1);
      }
    }

    // Map to automatic1111 terms for compatibility
    a1111Compatability(metadata);

    return removeEmpty(metadata);
  },
  encode: (meta) => {
    const comfy =
      typeof meta.comfy === 'string' ? fromJson<ComfyMetaSchema>(meta.comfy) : meta.comfy;

    return comfy && comfy.workflow ? JSON.stringify(comfy.workflow) : '';
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
  if (models && models.length > 0) {
    metadata.Model = models[0].replace(/\.[^/.]+$/, '');
  }
}

function getPromptText(node: ComfyNode, target: 'positive' | 'negative' = 'positive'): string {
  if (node.class_type === 'ControlNetApply')
    return getPromptText(node.inputs.conditioning as ComfyNode, target);
  if (node.class_type === 'FluxGuidance')
    return getPromptText(node.inputs.conditioning as ComfyNode, target);

  // Handle wildcard nodes
  if (node.inputs?.populated_text) node.inputs.text = node.inputs.populated_text;

  if (node.inputs?.text) {
    if (typeof node.inputs.text === 'string') return node.inputs.text;
    if (typeof (node.inputs.text as ComfyNode).class_type !== 'undefined')
      return getPromptText(node.inputs.text as ComfyNode, target);
  }
  if (node.inputs?.text_g) {
    if (!node.inputs?.text_l || node.inputs?.text_l === node.inputs?.text_g)
      return node.inputs.text_g as string;
    return `${node.inputs.text_g}, ${node.inputs.text_l}`;
  }
  if (node.inputs?.[`text_${target}`]) return node.inputs[`text_${target}`] as string;
  return '';
}

type ComfyNumber = ComfyNode | number;
function getNumberValue(input: ComfyNumber, valueNames = ['Value']) {
  if (typeof input === 'number') return input;
  for (const name of valueNames) {
    if (typeof input.inputs[name] !== 'undefined') return input.inputs[name] as number;
  }
  return 0;
}

// #region [types]
type ComfyNode = {
  inputs: Record<string, number | string | Array<string | number> | ComfyNode>;
  class_type: string;
};

type SamplerNode = {
  seed: number;
  noise_seed?: number;
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
