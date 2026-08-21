import type { BaseModel } from '~/shared/constants/basemodel.constants';

/**
 * Provider-imposed behaviour a user runs into at inference time, as opposed to the
 * licence terms in `baseLicenses` — the two are independent and a base model can carry
 * either, both or neither.
 */
export type BaseModelWarning = {
  title: string;
  points: string[];
  /** Wording the user ticks in the trainer before a run on this base can be submitted. */
  acknowledgement: string;
};

export const baseModelWarnings: Partial<Record<BaseModel, BaseModelWarning>> = {
  'Ideogram 4.0': {
    title: 'Ideogram 4 is SFW only — blocked jobs are not refunded',
    points: [
      'Ideogram does not support NSFW content.',
      'Ideogram 4 ships with a baked-in censorship layer that blocks a wide range of prompts, including many that are plainly safe for work.',
      'When you hit that layer the block comes from the model itself, not from Civitai — we cannot turn it off or work around it.',
      'A blocked job has already consumed compute, so there are no refunds for a censorship block.',
    ],
    acknowledgement:
      'I understand Ideogram 4 is SFW only, that its censorship layer can block prompts, and that blocked jobs are not refunded.',
  },
};

export const getBaseModelWarning = (baseModel: string | null | undefined) =>
  baseModel ? baseModelWarnings[baseModel as BaseModel] : undefined;
