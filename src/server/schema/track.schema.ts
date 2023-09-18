import { z } from 'zod';

export const addViewSchema = z.object({
  type: z.enum([
    'ProfileView',
    'ImageView',
    'PostView',
    'ModelView',
    'ModelVersionView',
    'ArticleView',
    'BountyView',
    'BountyEntryView',
  ]),
  entityType: z.enum([
    'User',
    'Image',
    'Post',
    'Model',
    'ModelVersion',
    'Article',
    'Bounty',
    'BountyEntry',
  ]),
  entityId: z.number(),
  details: z.object({}).passthrough().optional(),
});

export type AddViewSchema = z.infer<typeof addViewSchema>;

export type TrackShareInput = z.infer<typeof trackShareSchema>;
export const trackShareSchema = z.object({
  platform: z.enum(['reddit', 'twitter', 'clipboard']),
  url: z.string().url().trim().nonempty(),
});
