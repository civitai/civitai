import {
  flux1Config,
  fluxKontextModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/flux1.config';
import {
  googleConfig,
  googleModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/google.config';
import {
  openaiConfig,
  openaiModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/openai.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
  flux1: flux1Config,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>(
  ([] as [number, ImageGenConfigKey][])
    .concat([...openaiModelVersionToModelMap.keys()].map((key) => [key, 'openai']))
    .concat([...googleModelVersionToModelMap.keys()].map((key) => [key, 'google']))
    .concat([...fluxKontextModelVersionToModelMap.keys()].map((key) => [key, 'flux1']))
);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}
