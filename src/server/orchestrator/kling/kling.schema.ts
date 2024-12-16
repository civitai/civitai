import { KlingMode, KlingModel } from '@civitai/client';
import z from 'zod';
import { GenerationType } from '~/server/orchestrator/infrastructure/base.enums';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { unsupportedGenerationType } from '~/server/orchestrator/infrastructure/base.utils';

export const klingAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const klingDuration = ['5', '10'] as const;

const baseKlingSchema = z.object({
  engine: z.literal('kling'),
  workflow: z.string(),
  model: z.nativeEnum(KlingModel).default(KlingModel.V1_5).catch(KlingModel.V1_5),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  mode: z.nativeEnum(KlingMode).catch(KlingMode.STANDARD),
  duration: z.enum(klingDuration).default('5').catch('5'),
  cfgScale: z.number().min(0).max(1).default(0.5).catch(0.5),
  seed: seedSchema,
});

export const klingTxt2VidSchema = textEnhancementSchema.merge(baseKlingSchema).extend({
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(klingAspectRatios).default('1:1').catch('1:1'),
});

export const klingImg2VidSchema = imageEnhancementSchema.merge(baseKlingSchema);

export namespace Kling {
  export type Txt2VidInput = z.input<typeof textEnhancementSchema>;
  // export type Txt2VidSchema = z.infer<typeof textEnhancementSchema>;
  export type Img2VidInput = z.input<typeof imageEnhancementSchema>;
  // export type Img2VidSchema = z.infer<typeof imageEnhancementSchema>;

  export function validateInput(args: Txt2VidInput | Img2VidInput) {
    switch (args.type) {
      case GenerationType.txt2vid:
        return klingTxt2VidSchema.parse(args);
      case GenerationType.img2vid:
        return klingImg2VidSchema.parse(args);
      default:
        throw unsupportedGenerationType('kling');
    }
  }
}
