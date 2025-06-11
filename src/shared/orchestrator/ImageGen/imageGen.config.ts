import { flux1Config } from '~/shared/orchestrator/ImageGen/flux1.config';
import { googleConfig } from '~/shared/orchestrator/ImageGen/google.config';
import { openaiConfig } from '~/shared/orchestrator/ImageGen/openai.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
  flux1: flux1Config,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>([
  [1733399, 'openai'],
  [1889632, 'google'],
  [1892509, 'flux1'],
  [1892523, 'flux1'],
]);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}
