import { z } from 'zod';
import {
  negativePromptSchema,
  promptSchema,
  seedSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { workflowResourceSchema } from '~/server/schema/orchestrator/workflows.schema';

type HiDreamPrecision = (typeof hiDreamPrecisions)[number];
type HiDreamVariant = (typeof hiDreamVariants)[number];
type HiDreamResource = { id: number; precision: HiDreamPrecision; variant: HiDreamVariant };

export const hiDreamPrecisions = ['fp8', 'fp16'] as const;
export const hiDreamVariants = ['fast', 'dev', 'full'] as const;

export const hiDreamModelId = 1562709;
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

export function getHiDreamResourceFromVersionId(modelVersionId: number) {
  return hiDreamResources.find((x) => x.id === modelVersionId);
}

export function getHiDreamResourceFromPrecisionAndVariant({
  precision,
  variant,
}: {
  precision: string;
  variant: string;
}) {
  return hiDreamResources.find((x) => x.precision === precision && x.variant === variant);
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
  // precision: z.string(),
  // variant: z.string(),
});

export function getHiDreamInput(data: Record<string, unknown>) {
  const { resources, ...params } = schema.parse(data);
  const hiDreamResource = resources
    .map((r) => getHiDreamResourceFromVersionId(r.id))
    .find((x) => !!x);
  const variant = hiDreamResource?.variant ?? 'fast';
  const overrides = valueOverrides[variant as keyof typeof valueOverrides];

  return {
    resources,
    params: {
      ...params,
      ...overrides,
    },
  };
}
