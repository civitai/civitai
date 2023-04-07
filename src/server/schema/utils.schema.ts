import { z } from 'zod';
import { sanitizeHtml, santizeHtmlOptions } from '~/utils/html-helpers';

export const getSanitizedStringSchema = (options?: santizeHtmlOptions) =>
  z.preprocess((val) => {
    if (!val) return null;

    const str = String(val);
    const result = sanitizeHtml(str, options);
    console.log('________________________');
    console.log({ result });
    // null
    return result;
  }, z.string());
