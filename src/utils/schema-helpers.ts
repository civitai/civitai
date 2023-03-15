import { z } from 'zod';

export const safeUrl = z
  .string()
  .url()
  .refine((value) => {
    return value.startsWith('http://') || value.startsWith('https://');
  }, 'Must be a valid URL');
