import type { MochiVideoGenInput } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  seedSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('mochi').default('mochi').catch('mochi'),
  seed: seedSchema,
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
});

export const mochiGenerationConfig = VideoGenerationConfig2({
  label: 'Mochi',
  description: `Mochi 1 preview, by creators [https://www.genmo.ai](https://www.genmo.ai) is an open state-of-the-art video generation model with high-fidelity motion and strong prompt adherence in preliminary evaluation`,
  whatIfProps: [],
  metadataDisplayProps: ['process'],
  schema,
  processes: ['txt2vid'],
  transformFn: (data) => {
    delete data.priority;
    return { ...data, process: 'txt2vid', baseModel: 'Mochi' };
  },
  inputFn: (args): MochiVideoGenInput => {
    return { ...args };
  },
});
