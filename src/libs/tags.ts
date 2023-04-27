import { NsfwLevel, TagType } from '@prisma/client';
import { z } from 'zod';
import { moderationDisplayNames } from '~/libs/moderation';

export const taggableEntitySchema = z.enum(['model', 'image', 'tag']);
export type TaggableEntityType = z.infer<typeof taggableEntitySchema>;

export const tagVotableEntitySchema = z.enum(['model', 'image']);
export type TagVotableEntityType = z.infer<typeof tagVotableEntitySchema>;
export type VotableTagModel = {
  id: number;
  name: string;
  type: TagType;
  nsfw: NsfwLevel;
  score: number;
  upVotes: number;
  downVotes: number;
  automated?: boolean;
  vote?: number;
  needsReview?: boolean;
};

const tagNameOverrides = {
  ...moderationDisplayNames,
};
export function getTagDisplayName(name: string) {
  return tagNameOverrides[name] || name;
}

export const tagsNeedingReview = ['child', 'teen', 'baby', 'girl', 'boy'];
