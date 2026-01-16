import type { MantineColor } from '@mantine/core';
import type { ModelType } from '~/shared/utils/prisma/enums';
import type { BaseModel } from './base-model.constants';

// Color mapping for model types (used in badges)
export const modelTypeColors: Partial<Record<ModelType, MantineColor>> = {
  Checkpoint: 'blue',
  TextualInversion: 'yellow',
  Hypernetwork: 'cyan',
  AestheticGradient: 'grape',
  LORA: 'violet',
  LoCon: 'violet',
  DoRA: 'orange',
  Controlnet: 'green',
  Upscaler: 'lime',
  VAE: 'teal',
  Poses: 'pink',
  Wildcards: 'gray',
  Workflows: 'indigo',
  MotionModule: 'red',
};

export function getModelTypeColor(type: ModelType | string): MantineColor {
  return modelTypeColors[type as ModelType] ?? 'gray';
}

// Color mapping for base models (used in badges)
// Note: We only define colors for common base models; others fall back to gray
export const baseModelColors: Partial<Record<BaseModel, MantineColor>> = {
  'SD 1.5': 'cyan',
  'SD 2.1': 'blue',
  'SDXL 1.0': 'indigo',
  Pony: 'pink',
  'Flux.1 D': 'grape',
  'Flux.1 S': 'grape',
  Illustrious: 'teal',
  Other: 'gray',
};

export function getBaseModelColor(baseModel: BaseModel | string): MantineColor {
  // Check for exact match first
  if (baseModel in baseModelColors) {
    return baseModelColors[baseModel as BaseModel] ?? 'gray';
  }
  // Check for family prefix matches (e.g., "Flux.1 Krea" → grape)
  if (baseModel.startsWith('Flux')) return 'grape';
  if (baseModel.startsWith('SD 3')) return 'violet';
  if (baseModel.startsWith('SDXL')) return 'indigo';
  if (baseModel.startsWith('SD 2')) return 'blue';
  if (baseModel.startsWith('SD 1')) return 'cyan';
  return 'gray';
}
