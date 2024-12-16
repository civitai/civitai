import { HaiperVideoGenModel } from '@civitai/client';
import {
  negativePromptSchema,
  seedSchema,
  textEnhancementSchema,
} from './../infrastructure/base.schema';
import z from 'zod';
import {
  imageEnhancementSchema,
  promptSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';
import { GenerationType } from '~/server/orchestrator/infrastructure/base.enums';
import { unsupportedGenerationType } from '~/server/orchestrator/infrastructure/base.utils';

export const haiperAspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const haiperDuration = [2, 4, 8] as const;

const baseHaiperSchema = z.object({
  engine: z.literal('haiper'),
  workflow: z.string(),
  model: z
    .nativeEnum(HaiperVideoGenModel)
    .default(HaiperVideoGenModel.V2)
    .catch(HaiperVideoGenModel.V2),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  duration: numberEnum(haiperDuration).default(4).catch(4),
  seed: seedSchema,
});

export const haiperTxt2VidSchema = textEnhancementSchema.merge(baseHaiperSchema).extend({
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(haiperAspectRatios).default('1:1').catch('1:1'),
});

export const haiperImg2VidSchema = imageEnhancementSchema.merge(baseHaiperSchema);

export namespace Haiper {
  // export namespace Txt2Vid {
  //   export interface Schema extends SchemaInputOutput<typeof haiperTxt2VidSchema>
  // }
  // export type Txt2Vid = SchemaInputOutput<typeof haiperTxt2VidSchema>
  export type Txt2VidInput = z.input<typeof haiperTxt2VidSchema>;
  // export type Txt2VidSchema = z.infer<typeof haiperTxt2VidSchema>;
  export type Img2VidInput = z.input<typeof haiperImg2VidSchema>;
  // export type Img2VidSchema = z.infer<typeof haiperImg2VidSchema>;

  export function validateInput(args: Txt2VidInput | Img2VidInput) {
    switch (args.type) {
      case GenerationType.txt2vid:
        return haiperTxt2VidSchema.parse(args);
      case GenerationType.img2vid:
        return haiperImg2VidSchema.parse(args);
      default:
        throw unsupportedGenerationType('haiper');
    }
  }
}
