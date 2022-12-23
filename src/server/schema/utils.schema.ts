import sanitize from 'sanitize-html';
import { z } from 'zod';

import { sanitizeHtml } from '~/utils/html-helpers';

export const getSanitizedStringSchema = (options?: sanitize.IOptions) =>
  z.preprocess((val) => {
    if (!val) return null;

    const str = String(val);
    return sanitizeHtml(str, options);
  }, z.string());
