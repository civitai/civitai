import z from 'zod';
import { GenerationType } from '~/server/orchestrator/infrastructure/base.enums';
import {
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { unsupportedGenerationType } from '~/server/orchestrator/infrastructure/base.utils';

export const mochiTxt2VidSchema = textEnhancementSchema.extend({
  engine: z.literal('mochi'),
  workflow: z.string(),
  prompt: promptSchema,
  seed: seedSchema,
  enablePromptEnhancer: z.boolean().default(true),
});

export namespace Mochi {
  export type Txt2VidInput = z.input<typeof mochiTxt2VidSchema>;
  // export type Txt2VidSchema = z.infer<typeof mochiTxt2VidSchema>;

  export function validateInput(args: Txt2VidInput) {
    switch (args.type) {
      case GenerationType.txt2vid:
        return mochiTxt2VidSchema.parse(args);
      default:
        throw unsupportedGenerationType('mochi');
    }
  }
}
