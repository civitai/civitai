/**
 * Qwen family handler for the form-graph lane — three engines by ecosystem:
 * Qwen (sdcpp 20b, versioned), Qwen2 (fal), Qwen3 (DashScope qwen api).
 */

import type {
  ImageGenStepTemplate,
  Qwen20bCreateImageGenInput,
  Qwen20bEditImageGenInput,
  Qwen2CreateFalImageGenInput,
  Qwen2EditFalImageGenInput,
  QwenApiCreateImageGenInput,
  QwenApiEditImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type Txt2ImgVersion = '2509' | '2512';
type Img2ImgVersion = '2509' | '2511';
const qwenModelVersionMap = new Map<
  number,
  { process: 'txt2img' | 'img2img'; version: Txt2ImgVersion | Img2ImgVersion }
>([
  [2110043, { process: 'txt2img', version: '2509' }],
  [2552908, { process: 'txt2img', version: '2512' }],
  [2133258, { process: 'img2img', version: '2509' }],
  [2558804, { process: 'img2img', version: '2511' }],
]);

const imageSizeMap: Record<string, Qwen2CreateFalImageGenInput['imageSize']> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
};

const QWEN3_MODEL: QwenApiCreateImageGenInput['model'] = '3.0-pro';

export const createQwenInput = defineHandler<
  EcosystemData<'Qwen' | 'Qwen2' | 'Qwen3'>,
  [ImageGenStepTemplate]
>((data, ctx) => {
  const isTxt2Img = (data.workflow ?? '').startsWith('txt');
  const quantity = data.quantity ?? 1;

  if (data.ecosystem === 'Qwen3') {
    const baseInput = {
      engine: 'qwen' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      promptExtend: 'enablePromptExpansion' in data ? data.enablePromptExpansion : undefined,
      quantity,
      seed: data.seed,
    };

    return [
      {
        $type: 'imageGen',
        input: removeEmpty(
          isTxt2Img
            ? { ...baseInput, model: QWEN3_MODEL, operation: 'createImage' }
            : {
                ...baseInput,
                model: QWEN3_MODEL,
                operation: 'editImage',
                images: data.images?.map((x) => x.url) ?? [],
              }
        ) as QwenApiCreateImageGenInput | QwenApiEditImageGenInput,
      },
    ];
  }

  if (data.ecosystem === 'Qwen2') {
    const imageSize = data.aspectRatio?.value ? imageSizeMap[data.aspectRatio.value] : undefined;

    const baseInput = {
      engine: 'fal' as const,
      model: 'qwen2' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      imageSize,
      quantity,
      seed: data.seed,
    };

    return [
      {
        $type: 'imageGen',
        input: removeEmpty(
          isTxt2Img
            ? { ...baseInput, operation: 'createImage' }
            : {
                ...baseInput,
                operation: 'editImage',
                images: data.images?.map((x) => x.url) ?? [],
              }
        ) as Qwen2CreateFalImageGenInput | Qwen2EditFalImageGenInput,
      },
    ];
  }

  let process: 'txt2img' | 'img2img' = 'txt2img';
  let version: Txt2ImgVersion | Img2ImgVersion = '2512';
  if (data.model) {
    const match = qwenModelVersionMap.get(data.model.id);
    if (match) {
      process = match.process;
      version = match.version;
    }
  }

  const qwen1Data = 'resources' in data ? data : undefined;
  const loras = resourcesToLoras(qwen1Data?.resources, ctx.airs);

  const baseInput = {
    engine: 'sdcpp',
    ecosystem: 'qwen',
    model: '20b' as const,
    version,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: qwen1Data?.cfgScale,
    steps: qwen1Data?.steps,
    quantity,
    seed: data.seed,
    loras,
  };

  return [
    {
      $type: 'imageGen',
      input: removeEmpty(
        process === 'txt2img'
          ? { ...baseInput, operation: 'createImage' }
          : {
              ...baseInput,
              operation: 'editImage',
              images: data.images?.map((x) => x.url) ?? [],
            }
      ) as Qwen20bCreateImageGenInput | Qwen20bEditImageGenInput,
    },
  ];
});
