import { sanitizeHtml } from '~/utils/html-helpers';
import { z } from 'zod';

export const sanitizedStringSchema = z.preprocess((val) => {
  if (!val) return null;

  const str = String(val);
  return sanitizeHtml(str);
}, z.string().nullish());
