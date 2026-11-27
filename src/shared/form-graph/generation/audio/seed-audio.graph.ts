import type { z } from 'zod';
import { defineGraph } from 'form-graph';
import { SEED_AUDIO_MAX_PROMPT_LENGTH } from '~/shared/constants/seed-audio.constants';
import { imagesDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/** Seed Audio (BytePlus): API-only, so no model field; no duration either, the model picks it. */
export const seedAudio = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', imagesDef({ min: 0, max: 1 }))
  .field('prompt', {
    ...textDef('prompt', SEED_AUDIO_MAX_PROMPT_LENGTH),
    refine: (output: z.ZodString) =>
      output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
    meta: {
      required: true,
      targetKey: 'prompt',
      snippets: undefined,
      triggerWords: [] as string[],
      info: 'Put each spoken line in quotes, then describe the voice, language, emotion and pace, plus any music or ambience. The model picks the length, usually 5–10 seconds.',
      placeholder:
        'A calm narrator says "Welcome back to the show." Soft piano and ocean waves underneath.',
    },
  });
