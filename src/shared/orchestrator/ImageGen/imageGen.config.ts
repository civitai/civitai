import {
  flux1KontextConfig,
  fluxKontextModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import {
  geminiConfig,
  geminiModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/gemini.config';
import {
  googleConfig,
  googleModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/google.config';
import {
  openaiConfig,
  openaiModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/openai.config';
import { qwenConfig, qwenModelVersionToModelMap } from '~/shared/orchestrator/ImageGen/qwen.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
  flux1: flux1KontextConfig,
  gemini: geminiConfig,
  qwen: qwenConfig,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>(
  ([] as [number, ImageGenConfigKey][])
    .concat([...openaiModelVersionToModelMap.keys()].map((key) => [key, 'openai']))
    .concat([...googleModelVersionToModelMap.keys()].map((key) => [key, 'google']))
    .concat([...fluxKontextModelVersionToModelMap.keys()].map((key) => [key, 'flux1']))
    .concat([...geminiModelVersionToModelMap.keys()].map((key) => [key, 'gemini']))
    .concat([...qwenModelVersionToModelMap.keys()].map((key) => [key, 'qwen']))
);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}
