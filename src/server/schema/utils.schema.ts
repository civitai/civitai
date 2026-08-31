import * as z from 'zod';
import type { santizeHtmlOptions } from '~/utils/html-sanitize-helpers';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

export const getSanitizedStringSchema = (options?: santizeHtmlOptions) =>
  z.preprocess((val, ctx) => {
    if (!val) return '';
    const str = String(val);

    try {
      return sanitizeHtml(str, options);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: (e as any).message,
      });
    }
  }, z.string());
