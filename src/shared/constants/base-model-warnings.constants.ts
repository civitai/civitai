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
  'Ideogram 4.5': {
    title: 'Ideogram 4.5 is SFW only',
    points: [
      "Ideogram's terms forbid sexually explicit content, and Ideogram 4.5 rejects NSFW prompts.",
      'The block comes from Ideogram, not from Civitai — we cannot turn it off or work around it.',
    ],
    acknowledgement:
      'I understand Ideogram 4.5 is SFW only and that Ideogram can reject prompts it considers unsafe.',
  },
};

/** The generator shows these in place of the per-base-model warnings for the whole ecosystem. */
export const ecosystemWarnings: Record<string, Omit<BaseModelWarning, 'acknowledgement'>> = {
  Ideogram: {
    title: 'Ideogram is SFW only',
    points: [
      "Ideogram does not support NSFW content, and Ideogram's terms forbid sexually explicit output.",
      'Both versions block a wide range of prompts, including some that are plainly safe for work. The block comes from Ideogram, not from Civitai — we cannot turn it off or work around it.',
      'Ideogram 4.0: a blocked job has already consumed compute, so there are no refunds for a censorship block.',
    ],
  },
};

export const getBaseModelWarning = (baseModel: string | null | undefined) =>
  baseModel ? baseModelWarnings[baseModel as BaseModel] : undefined;
