import { MiniMaxVideoGenModel } from '@civitai/client';
import z from 'zod';
import { GenerationType } from '~/server/orchestrator/infrastructure/base.enums';
import {
  imageEnhancementSchema,
  promptSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { unsupportedGenerationType } from '~/server/orchestrator/infrastructure/base.utils';

const baseMinimaxSchema = z.object({
  engine: z.literal('minimax'),
  workflow: z.string(),
  model: z
    .nativeEnum(MiniMaxVideoGenModel)
    .default(MiniMaxVideoGenModel.HAILOU)
    .catch(MiniMaxVideoGenModel.HAILOU),
  prompt: promptSchema,
});

const minRatio = 2 / 5;
const maxRatio = 5 / 2;
const minSize = 300;

export const minimaxTxt2VidSchema = textEnhancementSchema.merge(baseMinimaxSchema);
export const minimaxImg2VidSchema = imageEnhancementSchema.merge(baseMinimaxSchema);
// .superRefine(({ sourceImageUrl, width, height }, ctx) => {
//   const
// });

export namespace Minimax {
  export type Txt2VidInput = z.input<typeof minimaxTxt2VidSchema>;
  // export type Txt2VidSchema = z.infer<typeof minimaxTxt2VidSchema>;
  export type Img2VidInput = z.input<typeof minimaxImg2VidSchema>;
  // export type Img2VidSchema = z.infer<typeof minimaxImg2VidSchema>;

  export function validateInput(args: Txt2VidInput | Img2VidInput) {
    switch (args.type) {
      case GenerationType.txt2vid:
        return minimaxTxt2VidSchema.parse(args);
      case GenerationType.img2vid:
        return minimaxImg2VidSchema.parse(args);
      default:
        throw unsupportedGenerationType('minimax');
    }
  }
}
