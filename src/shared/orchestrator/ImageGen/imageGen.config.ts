import {
  flux1KontextConfig,
  fluxKontextModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import { geminiConfig, geminiModelVersionMap } from '~/shared/orchestrator/ImageGen/gemini.config';
import {
  googleConfig,
  googleModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/google.config';
import {
  openaiConfig,
  openaiModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/openai.config';
import {
  seedreamConfig,
  seedreamModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/seedream.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
  flux1: flux1KontextConfig,
  gemini: geminiConfig,
  seedream: seedreamConfig,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>(
  ([] as [number, ImageGenConfigKey][])
    .concat([...openaiModelVersionToModelMap.keys()].map((key) => [key, 'openai']))
    .concat([...googleModelVersionToModelMap.keys()].map((key) => [key, 'google']))
    .concat([...fluxKontextModelVersionToModelMap.keys()].map((key) => [key, 'flux1']))
    .concat([...geminiModelVersionMap.keys()].map((key) => [key, 'gemini']))
    .concat([...seedreamModelVersionToModelMap.keys()].map((key) => [key, 'seedream']))
);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}
