import { z } from 'zod';

/**
 * The `flag:value` protocol the four `setFlag` actions and their three pickers post.
 *
 * Hand-splitting it is what this exists to stop: `'minor'` and `'minor:banana'` both yield
 * `value !== 'true'`, so a malformed post CLEARS the flag instead of being refused.
 */
export const IMAGE_FLAG_VALUES = ['poi:true', 'poi:false', 'minor:true', 'minor:false'] as const;

export const imageFlagValueSchema = z.enum(IMAGE_FLAG_VALUES);

export type ImageFlag = 'poi' | 'minor';

export const imageFlagValue = (flag: ImageFlag, on: boolean) => `${flag}:${on}` as const;

export const parseImageFlagValue = (value: string): { flag: ImageFlag; value: boolean } | null => {
  const parsed = imageFlagValueSchema.safeParse(value);
  return parsed.success ? splitImageFlagValue(parsed.data) : null;
};

/** For a caller that already validated the value with `imageFlagValueSchema`. */
export const splitImageFlagValue = (value: (typeof IMAGE_FLAG_VALUES)[number]) => {
  const [flag, on] = value.split(':');
  return { flag: flag as ImageFlag, value: on === 'true' };
};
