import { TagType } from '@prisma/client';
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
  score: number;
  upVotes: number;
  downVotes: number;
  automated?: boolean;
  vote?: number;
};

const tagNameOverrides = {
  ...moderationDisplayNames,
};
export function getTagDisplayName(name: string) {
  return tagNameOverrides[name] || name;
}
