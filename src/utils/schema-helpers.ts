import { z } from 'zod';

const safeUrl = z
  .string()
  .url()
  .refine((value) => {
    return value?.startsWith('http://') || value?.startsWith('https://');
  }, 'Must be a valid URL');

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());

const numberString = z.preprocess((val) => (val ? Number(val) : undefined), z.number());

const usernameValidationSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.');

export const zc = {
  safeUrl,
  booleanString,
  numberString,
  usernameValidationSchema,
};
