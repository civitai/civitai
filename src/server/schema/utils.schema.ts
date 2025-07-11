import * as z from 'zod/v4';
import type { santizeHtmlOptions } from '~/utils/html-helpers';
import { sanitizeHtml } from '~/utils/html-helpers';

export const getSanitizedStringSchema = (options?: santizeHtmlOptions) =>
  z.preprocess((val, ctx) => {
    if (!val) return '';
    const str = String(val);

    try {
      return sanitizeHtml(str, options);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: (e as any).message,
      });
    }
  }, z.string());

// export const getSanitizedStringSchema = (options?: santizeHtmlOptions) =>
//   z
//     .preprocess((val) => (!val ? '' : `${val}`), z.string())
//     .transform((val, ctx) => {
//       try {
//         const blockedDomains = getBlockedDomains(val);
//         if (blockedDomains.length) throw new Error(`invalid urls: ${blockedDomains.join(', ')}`);
//         return sanitizeHtml(val, options);
//       } catch (e) {
//         ctx.addIssue({
//           code: z.ZodIssueCode.custom,
//           message: (e as any).message,
//         });
//       }
//     });
