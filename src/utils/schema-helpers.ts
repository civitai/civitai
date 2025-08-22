import * as z from 'zod';

const safeUrl = z.url().refine((value) => {
  return value?.startsWith('http://') || value?.startsWith('https://');
}, 'Must be a valid URL');

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());

const numberString = z.preprocess((val) => (val ? Number(val) : undefined), z.number());

export const zc = {
  safeUrl,
  booleanString,
  numberString,
};
