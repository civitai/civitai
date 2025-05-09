import { MochiVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseGenerationSchema,
  promptSchema,
  seedSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const schema = baseGenerationSchema.extend({
  engine: z.literal('mochi').catch('mochi'),
  seed: seedSchema,
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
});

export const mochiGenerationConfig = VideoGenerationConfig2({
  label: 'Mochi',
  description: `Mochi 1 preview, by creators [https://www.genmo.ai](https://www.genmo.ai) is an open state-of-the-art video generation model with high-fidelity motion and strong prompt adherence in preliminary evaluation`,
  whatIfProps: [],
  metadataDisplayProps: [],
  schema,
  processes: ['txt2vid'],
  transformFn: (data) => ({ ...data, process: 'txt2vid' }),
  inputFn: (args): MochiVideoGenInput => {
    return { ...args };
  },
});
