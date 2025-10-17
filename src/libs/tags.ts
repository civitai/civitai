import type { TagSource, TagType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { moderationDisplayNames } from '~/libs/moderation';
import type { NsfwLevel } from '~/server/common/enums';

export const taggableEntitySchema = z.enum(['model', 'image', 'tag', 'article']);
export type TaggableEntityType = z.infer<typeof taggableEntitySchema>;

export const tagVotableEntitySchema = z.enum(['model', 'image']);
export type TagVotableEntityType = z.infer<typeof tagVotableEntitySchema>;
export type VotableTagModel = {
  id: number;
  name: string;
  type: TagType;
  nsfwLevel: NsfwLevel;
  score: number;
  upVotes: number;
  downVotes: number;
  automated?: boolean;
  vote?: number;
  needsReview?: boolean;
  concrete?: boolean;
  lastUpvote?: Date | null;
};

const tagNameOverrides: Record<string, string> = {
  ...moderationDisplayNames,
  '1girl': 'woman',
  '2girls': 'women',
  '3girls': 'women',
  '4girls': 'women',
  '5girls': 'women',
  '6+girls': 'women',
  'multiple girls': 'women',
  '1boy': 'man',
  '2boys': 'men',
  '3boys': 'men',
  '4boys': 'men',
  '5boys': 'men',
  '6+boys': 'men',
  'multiple boys': 'men',
  pussy: 'vagina',
  ass: 'butt',
  'ass focus': 'butt focus',
  'huge ass': 'huge butt',
};
export function getTagDisplayName(name: string) {
  return tagNameOverrides[name] || name;
}

export const tagsNeedingReview = [
  'child',
  'teen',
  'baby',
  'girl',
  'boy',
  'female child',
  'male child',
  'oppai loli',
  'child on child',
];
export const tagsToIgnore: Partial<Record<TagSource, string[]>> = {
  Rekognition: [
    'baby',
    'emaciated bodies',
    'weapons',
    // Adding these since Rekognition seems to be tagging anything red...
    'extremist',
    'hate symbols',
    'nazi party',
    'white supremacy',
  ],
};
