import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { removeEmpty } from '~/utils/object-helpers';
import { CollectionItemExpanded } from '~/server/services/collection.service';
import { CollectionItemStatus } from '@prisma/client';
import { ImageProps } from '~/components/ImageGuard/ImageGuard';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

const collectionQueryParamSchema = z
  .object({
    collectionId: z
      .union([z.array(z.coerce.number()), z.coerce.number()])
      .transform((val) => (Array.isArray(val) ? val[0] : val)),
  })
  .partial();

export type CollectionQueryParams = z.output<typeof collectionQueryParamSchema>;
export const useCollectionQueryParams = () => {
  const { query, pathname, push } = useRouter();

  return useMemo(() => {
    const result = collectionQueryParamSchema.safeParse(query);
    const data: CollectionQueryParams = result.success ? result.data : {};

    return {
      ...data,
      set: (filters: Partial<CollectionQueryParams>, pathnameOverride?: string) => {
        push(
          {
            pathname: pathnameOverride ?? pathname,
            query: removeEmpty({ ...query, ...filters }),
          },
          undefined,
          {
            shallow: !pathnameOverride || pathname === pathnameOverride,
          }
        );
      },
    };
  }, [query, pathname, push]);
};

export const getCollectionItemReviewData = (collectionItem: CollectionItemExpanded) => {
  const reviewData: {
    title: string;
    description: string;
    images: ImageProps[];
    imageSrc?: string;
    addedBy: string;
    status: CollectionItemStatus;
    type?: string;
    user?: Partial<UserWithCosmetics> | null;
  } = {
    title: '',
    description: '',
    images: [],
    addedBy: '',
    status: CollectionItemStatus.REVIEW,
  };

  switch (collectionItem.type) {
    case 'image': {
      reviewData.images = [collectionItem.data];
      reviewData.user = collectionItem.data.user;
      break;
    }
    case 'model': {
      reviewData.images = collectionItem.data.image ? [collectionItem.data.image] : [];
      reviewData.user = collectionItem.data.user;
      break;
    }
    case 'post': {
      reviewData.images = collectionItem.data.image ? [collectionItem.data.image] : [];
      reviewData.user = collectionItem.data.user;
      break;
    }
    case 'article': {
      console.log(collectionItem);
      reviewData.imageSrc = collectionItem.data.cover;
      reviewData.user = collectionItem.data.user;
      reviewData.title = collectionItem.data.title;
      break;
    }
    default:
      break;
  }

  return reviewData;
};
