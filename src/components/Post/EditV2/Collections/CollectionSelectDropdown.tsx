import { Alert, Anchor, Divider, Group, Select, Stack, Text } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { useCollectionsForPostCreation } from '~/components/Collections/collection.utils';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { useMutatePost } from '~/components/Post/post.utils';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const useCollectionsForPostEditor = () => {
  const { collections: queryCollectionIds, collectionId: queryCollectionId } = usePostEditParams();
  const { post, updateCollection, collectionId, collectionTagId, collectionItemExists } =
    usePostEditStore((state) => ({
      post: state.post,
      updateCollection: state.updateCollection,
      collectionId: state.collectionId,
      collectionTagId: state.collectionTagId,
      collectionItemExists: state.collectionItemExists,
    }));

  const collectionIds = useMemo(() => {
    return [
      ...((queryCollectionIds as number[]) ?? []),
      queryCollectionId,
      collectionId,
      post?.collectionId,
    ].filter(isDefined);
  }, [queryCollectionIds, collectionId, post]);

  useEffect(() => {
    if (queryCollectionId && !collectionId) {
      updateCollection(queryCollectionId);
    }
  }, [queryCollectionId]);

  useEffect(() => {
    if (!collectionId && post?.collectionId) {
      updateCollection(post.collectionId, post.collectionTagId, post.collectionItemExists);
    }
  }, [post?.collectionId, collectionId]);

  const { collections = [] } = useCollectionsForPostCreation({ collectionIds });

  return {
    post,
    collections,
    updateCollection,
    collectionId,
    collectionTagId,
    collectionIds,
    activeCollection: collections.find((c) => c.id === collectionId),
    collectionItemExists,
  };
};

export const CollectionSelectDropdown = () => {
  const {
    post,
    collections,
    updateCollection,
    collectionId,
    collectionTagId,
    collectionIds,
    collectionItemExists,
  } = useCollectionsForPostEditor();
  const { updateCollectionTagId, updatingCollectionTagId } = useMutatePost();

  const writeableCollections = useMemo(() => {
    return collections.filter(
      (collection) => collection.permissions?.write || collection.permissions?.writeReview
    );
  }, [collections]);

  const isContestCollectionsOnly = writeableCollections.every(
    (collection) => collection.mode === CollectionMode.Contest
  );

  const selectedCollection = collectionId
    ? writeableCollections.find((c) => c.id === collectionId)
    : null;

  const selectOpts = writeableCollections.map((collection) => ({
    value: collection.id.toString(),
    label: getDisplayName(collection.name),
  }));

  const handlePublishedPostCollectionTagUpdate = async (tagId: number) => {
    await updateCollectionTagId({
      id: post?.id as number,
      collectionTagId: tagId,
    });

    updateCollection(collectionId as number, tagId);
  };

  if (!writeableCollections.length || !collectionIds.length) {
    return null;
  }

  const availableTags = (selectedCollection?.tags ?? []).filter(
    (t) => !t.filterableOnly || t.id === collectionTagId
  );

  return (
    <Stack gap="xs">
      <Divider label="Collection details for this post" />
      {!post?.publishedAt && collectionId && selectedCollection?.metadata.termsOfServicesUrl && (
        <Alert color="blue">
          By submitting an entry to {selectedCollection.name}, you agree to the competition&rsquo;s{' '}
          {selectedCollection.metadata.rulesUrl && (
            <>
              <Anchor
                href={selectedCollection.metadata.rulesUrl}
                target="_blank"
                rel="noopener nofollow"
              >
                Rules
              </Anchor>{' '}
              and{' '}
            </>
          )}
          <Anchor
            href={selectedCollection.metadata.termsOfServicesUrl}
            target="_blank"
            rel="noopener nofollow"
          >
            Terms of Service
          </Anchor>
          .
        </Alert>
      )}
      {!post?.publishedAt ? (
        <Group>
          <Select
            label={isContestCollectionsOnly ? 'Contest Selection' : 'Select collection'}
            data={selectOpts}
            value={collectionId ? collectionId.toString() : null}
            onChange={(value: string) =>
              value ? updateCollection(parseInt(value, 10), null) : updateCollection(null, null)
            }
            disabled={!!post?.publishedAt}
            placeholder={`Add to ${isContestCollectionsOnly ? 'contest' : 'collection'}`}
            radius="xl"
            clearable
            size="xs"
            styles={{
              input: {
                height: 32,
              },
            }}
            tt="capitalize"
          />
          {selectedCollection && availableTags.length > 0 && !post?.publishedAt && (
            <Select
              label="Select Entry Category"
              data={availableTags.map((tag) => ({
                value: tag.id.toString(),
                label: tag.name.toUpperCase(),
              }))}
              value={collectionTagId ? collectionTagId.toString() : null}
              onChange={(value: string) =>
                value
                  ? updateCollection(collectionId as number, parseInt(value, 10))
                  : updateCollection(collectionId as number, null)
              }
              placeholder="Select category"
              radius="xl"
              clearable
              size="xs"
              styles={{
                input: {
                  height: 32,
                },
              }}
            />
          )}
        </Group>
      ) : selectedCollection ? (
        <Stack>
          <Alert color="gray">
            <Stack gap={0}>
              <Text size="sm">
                This post has been created for the{' '}
                <Text component="span" weight="bold">
                  {selectedCollection.name}
                </Text>{' '}
                collection.
              </Text>
              <Anchor
                href={`/collections/${selectedCollection.id}`}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
              >
                View collection
              </Anchor>
            </Stack>
          </Alert>

          {selectedCollection && selectedCollection.tags.length > 0 && collectionItemExists && (
            <Select
              label="Update Entry Category"
              data={selectedCollection.tags.map((tag) => ({
                value: tag.id.toString(),
                label: tag.name.toUpperCase(),
              }))}
              value={collectionTagId ? collectionTagId.toString() : null}
              onChange={(value: string) => {
                handlePublishedPostCollectionTagUpdate(parseInt(value, 10));
              }}
              disabled={updatingCollectionTagId}
              placeholder="Select category"
              radius="xl"
              size="xs"
              styles={{
                input: {
                  height: 32,
                },
              }}
            />
          )}

          {selectedCollection && !collectionItemExists && (
            <Alert color="red">
              <Stack gap={0}>
                <Text size="sm">
                  We could not find a link to the entry record for this post. This post might have
                  been removed from the{' '}
                  <Text weight="bold" component="span">
                    {selectedCollection.name}
                  </Text>{' '}
                  collection.
                </Text>
              </Stack>
            </Alert>
          )}
        </Stack>
      ) : null}

      <Divider />
    </Stack>
  );
};
