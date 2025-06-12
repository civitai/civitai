import type { TextToImageInput } from '@civitai/client';
import { Scheduler } from '@civitai/client';
import { z } from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  resourceSchema,
  seedSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { workflowResourceSchema } from '~/server/schema/orchestrator/workflows.schema';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { parseAIR } from '~/utils/string-helpers';

type HiDreamPrecision = (typeof hiDreamPrecisions)[number];
type HiDreamVariant = (typeof hiDreamVariants)[number];
type HiDreamResource = { id: number; precision: HiDreamPrecision; variant: HiDreamVariant };

export const hiDreamPrecisions = ['fp8', 'fp16'] as const;
export const hiDreamVariants = ['fast', 'dev', 'full'] as const;

const hiDreamModelId = 1562709;
const hiDreamResources: HiDreamResource[] = [
  {
    id: 1772448,
    variant: 'full',
    precision: 'fp8',
  },
  {
    id: 1771369,
    variant: 'dev',
    precision: 'fp8',
  },
  {
    id: 1770945,
    variant: 'fast',
    precision: 'fp8',
  },
  {
    id: 1768354,
    variant: 'full',
    precision: 'fp16',
  },
  {
    id: 1769068,
    variant: 'dev',
    precision: 'fp16',
  },
  {
    id: 1768731,
    variant: 'fast',
    precision: 'fp16',
  },
];

const valueOverrides = {
  fast: {
    cfgScale: 1,
    negativePrompt: null,
    sampler: 'LCM',
    steps: 16,
  },
  dev: {
    cfgScale: 1,
    negativePrompt: null,
    sampler: 'LCM',
    steps: 28,
  },
  full: {
    cfgScale: 5,
    steps: 50,
    sampler: 'UniPC',
  },
};

// TODO - get values for variant and precesion when creating from specific resources
// export function getHiDreamInputFromResourceId(resourceId: number) {

// }

function getResourceId(precision: string, variant: string) {
  const resource = hiDreamResources.find((x) => x.precision === precision && x.variant === variant);
  if (!resource) throw new Error('incompatible HiDream model variant');
  return resource.id;
}

const schema = z.object({
  baseModel: z.literal('HiDream').catch('HiDream'),
  workflow: z.string(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema.nullable().default(null),
  width: z.number(),
  height: z.number(),
  sampler: z.string().default('LCM'),
  cfgScale: z.number().optional(),
  steps: z.number().optional(),
  seed: seedSchema,
  disablePoi: z.boolean().default(false),
  quantity: z.number().default(1),
  // model: resourceSchema,
  // resources: resourceSchema.array().default([]),
  resources: workflowResourceSchema.array().default([]),
  precision: z.string(),
  variant: z.string(),
});

export function getHiDreamInput(data: Record<string, unknown>) {
  const { resources, ...params } = schema.parse(data);
  const resourceId = getResourceId(params.precision, params.variant);
  const overrides = valueOverrides[params.variant as keyof typeof valueOverrides];
  for (const { id: hiDreamResourceId } of hiDreamResources) {
    const index = resources.findIndex((x) => x.id === hiDreamResourceId);
    if (index > -1) {
      resources[index].id = resourceId;
      break;
    }
  }

  return {
    resources,
    params: {
      ...params,
      ...overrides,
    },
  };
}

// export const hiDreamConfig = VideoGenerationConfig2({
//   label: 'HiDream',
//   whatIfProps: ['steps', 'model', 'cfgScale'],
//   metadataDisplayProps: [],
//   schema,
//   processes: ['txt2img'],
//   transformFn: (data) => {
//     const variant = getModelVariant(data.model.air);
//     const overrides = valueOverrides[variant];

//     return {
//       baseModel: data.baseModel,
//       model: data.model,
//       prompt: data.prompt,
//       ...overrides,
//     };
//   },
//   inputFn: ({ model, ...args }): TextToImageInput => {
//     return {
//       model: model.air,
//       ...args,
//     };
//   },
// });
