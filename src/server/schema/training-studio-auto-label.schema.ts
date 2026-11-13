import * as z from 'zod';
import { AUTO_LABEL_BATCH_SIZE } from '~/server/schema/training.schema';

export type StudioAutoLabelSubmitInput = z.infer<typeof studioAutoLabelSubmitSchema>;
export const studioAutoLabelSubmitSchema = z
  .object({
    mode: z.enum(['tag', 'caption']),
    media: z.enum(['image', 'video', 'audio']),
    items: z
      .array(
        z.object({
          mediaUrl: z
            .url()
            .max(2048)
            .refine((u) => u.startsWith('https://'), { message: 'mediaUrl must be HTTPS' }),
          key: z.string().min(1).max(256),
        })
      )
      .min(1)
      .max(AUTO_LABEL_BATCH_SIZE)
      .refine((items) => new Set(items.map((i) => i.key)).size === items.length, {
        message: 'Duplicate key in batch',
      }),
  })
  // wdTagging can't read audio; the Studio only offers captions for audio.
  .refine((v) => !(v.media === 'audio' && v.mode === 'tag'), {
    message: 'Audio auto-label only supports caption mode',
    path: ['mode'],
  });

export type StudioAutoLabelPollInput = z.infer<typeof studioAutoLabelPollSchema>;
export const studioAutoLabelPollSchema = z.object({ workflowId: z.string().min(1).max(128) });
