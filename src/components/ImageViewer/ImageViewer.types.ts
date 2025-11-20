import type { MediaType } from '~/shared/utils/prisma/enums';
import type { NsfwLevel } from '~/server/common/enums';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { SimpleUser } from '~/server/selectors/user.selector';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';

// Common image interface used across the application
export interface ImageProps {
  id: number;
  url: string;
  name: string | null;
  meta?: ImageMetaProps | null;
  hash: string | null;
  width: number | null;
  height: number | null;
  createdAt?: Date | null;
  type: MediaType;
  nsfwLevel: NsfwLevel;
  postId?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
  tags?: Array<{ id: number }> | number[];
  metadata?: MixedObject | null;
  publishedAt?: Date | null;
  thumbnailUrl?: string | null;
  minor?: boolean;
  poi?: boolean;
}

export type ImageGuardConnect = {
  entityType:
    | 'model'
    | 'modelVersion'
    | 'review'
    | 'user'
    | 'post'
    | 'collectionItem'
    | 'collection'
    | 'bounty'
    | 'bountyEntry'
    | 'club'
    | 'article';
  entityId: string | number;
};
