import { childBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';

const childTagIds = new Set<number>(childBrowsingTagIds);

/** Above PG13 and carrying one of `childBrowsingTagIds`: left out of every search document. */
export const isTaggedMatureImage = (image: { nsfwLevel: number; tags?: number[] }) =>
  image.nsfwLevel > NsfwLevel.PG13 && !!image.tags?.some((tagId) => childTagIds.has(tagId));
