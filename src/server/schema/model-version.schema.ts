import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { imageSchema } from '~/server/schema/image.schema';
import { modelFileSchema } from '~/server/schema/model-file.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export const modelVersionUpsertSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  baseModel: z.enum(constants.baseModels),
  description: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'ul', 'ol', 'li'],
  }).nullish(),
  steps: z.number().nullish(),
  epochs: z.number().nullish(),
  images: z
    .array(imageSchema)
    .min(1, 'At least one example image must be uploaded')
    .max(20, 'You can only upload up to 20 images'),
  trainedWords: z.array(z.string()),
  files: z.array(modelFileSchema),
});
