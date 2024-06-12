import { Select } from '@mantine/core';
import { CollectionMode } from '@prisma/client';
import { useEffect, useMemo, useState } from 'react';
import { useCollectionsForPostCreation } from '~/components/Collections/collection.utils';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const CollectionSelectDropdown = () => {
  const { collections: queryCollectionIds, collectionId } = usePostEditParams();
  const { post, updatePost } = usePostEditStore((state) => ({
    post: state.post,
    updatePost: state.updatePost,
  }));
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(
    post?.collectionId ?? collectionId ?? null
  );
  const debounce = useDebouncer(1000);

  const collectionIds = useMemo(() => {
    return [...((queryCollectionIds as number[]) ?? []), collectionId, post?.collectionId].filter(
      isDefined
    );
  }, [queryCollectionIds, collectionId, post]);

  const { collections = [] } = useCollectionsForPostCreation({ collectionIds });
  const writeableCollections = useMemo(() => {
    return collections.filter(
      (collection) => collection.permissions?.write || collection.permissions?.writeReview
    );
  }, [collections]);

  const isContestCollectionsOnly = writeableCollections.every(
    (collection) => collection.mode === CollectionMode.Contest
  );

  const { mutate, isLoading } = trpc.post.update.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to update post',
        error: new Error(error.message),
      });
    },
  });

  useEffect(() => {
    if (post && post.collectionId !== selectedCollectionId) {
      debounce(() =>
        mutate(
          {
            id: post.id,
            collectionId: selectedCollectionId,
          },
          {
            onSuccess: async (_, post) => {
              const { id, collectionId } = post;
              updatePost((data) => {
                data.collectionId = collectionId ?? null;
              });
            },
          }
        )
      );
    }
  }, [selectedCollectionId]); // eslint-disable-line

  const selectOpts = writeableCollections.map((collection) => ({
    value: collection.id.toString(),
    label: collection.name,
  }));

  if (!writeableCollections.length || !collectionIds.length) {
    return null;
  }

  return (
    <Select
      label={isContestCollectionsOnly ? 'Contest Selection' : 'Select collection'}
      data={selectOpts}
      value={selectedCollectionId ? selectedCollectionId.toString() : null}
      onChange={(value: string) =>
        value ? setSelectedCollectionId(parseInt(value, 10)) : setSelectedCollectionId(null)
      }
      disabled={!!post?.publishedAt || isLoading}
      placeholder={`Add to ${isContestCollectionsOnly ? 'contest' : 'collection'}`}
      radius="xl"
      labelProps={{ style: { display: 'none' } }}
      clearable
      size="xs"
      styles={{
        input: {
          height: 32,
        },
      }}
    />
  );
};
