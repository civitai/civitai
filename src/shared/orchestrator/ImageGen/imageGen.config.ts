import {
  flux1KontextConfig,
  fluxKontextModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import {
  flux2Config,
  flux2ModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/flux2.config';
import { geminiConfig, geminiModelVersionMap } from '~/shared/orchestrator/ImageGen/gemini.config';
import {
  googleConfig,
  googleModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/google.config';
import {
  openaiConfig,
  openaiModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/openai.config';
import { qwenConfig, qwenModelVersionToModelMap } from '~/shared/orchestrator/ImageGen/qwen.config';
import {
  seedreamConfig,
  seedreamModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/seedream.config';
import {
  zImageConfig,
  zImageModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/zImage.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
  flux1: flux1KontextConfig,
  flux2: flux2Config,
  gemini: geminiConfig,
  qwen: qwenConfig,
  seedream: seedreamConfig,
  zImage: zImageConfig,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>(
  ([] as [number, ImageGenConfigKey][])
    .concat([...openaiModelVersionToModelMap.keys()].map((key) => [key, 'openai']))
    .concat([...googleModelVersionToModelMap.keys()].map((key) => [key, 'google']))
    .concat([...fluxKontextModelVersionToModelMap.keys()].map((key) => [key, 'flux1']))
    .concat([...flux2ModelVersionToModelMap.keys()].map((key) => [key, 'flux2']))
    .concat([...geminiModelVersionMap.keys()].map((key) => [key, 'gemini']))
    .concat([...qwenModelVersionToModelMap.keys()].map((key) => [key, 'qwen']))
    .concat([...seedreamModelVersionToModelMap.keys()].map((key) => [key, 'seedream']))
    .concat([...zImageModelVersionToModelMap.keys()].map((key) => [key, 'zImage']))
);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}

export function getImageGenConfigKey(modelVersionId: number): ImageGenConfigKey | undefined {
  return imageGenModelVersionMap.get(modelVersionId);
}
