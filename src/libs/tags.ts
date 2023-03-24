import { TagType } from '@prisma/client';
import { z } from 'zod';

export const taggableEntitySchema = z.enum(['model', 'image', 'tag']);
export type TaggableEntityType = z.infer<typeof taggableEntitySchema>;

export const tagVotableEntitySchema = z.enum(['model', 'image']);
export type TagVotableEntityType = z.infer<typeof tagVotableEntitySchema>;
export type VotableTag = {
  id: number;
  name: string;
  type: TagType;
  score: number;
  upVotes: number;
  downVotes: number;
  automated?: boolean;
  vote?: number;
};
