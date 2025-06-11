import { googleConfig } from '~/shared/orchestrator/ImageGen/google.config';
import { openaiConfig } from '~/shared/orchestrator/ImageGen/openai.config';

type ImageGenConfigKey = keyof typeof imageGenConfig;
export const imageGenConfig = {
  openai: openaiConfig,
  google: googleConfig,
};

export const imageGenModelVersionMap = new Map<number, ImageGenConfigKey>([
  [1733399, 'openai'],
  [1889632, 'google'],
]);

export function getModelVersionUsesImageGen(modelVersionId: number) {
  return !!imageGenModelVersionMap.get(modelVersionId);
}
