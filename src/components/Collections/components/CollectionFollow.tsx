import React from 'react';
import { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { Button, Group } from '@mantine/core';
import { IconMinus, IconPlus, IconProgress } from '@tabler/icons-react';
import { CollectionByIdModel } from '~/types/router';

const CollectionFollowAction = ({ collection, permissions, ...btnProps }: Props) => {
  const utils = trpc.useContext();

  const { isLoading: creatingFollow, mutate: followCollection } =
    trpc.collection.follow.useMutation({
      async onSuccess() {
        await utils.collection.getById.invalidate({ id: collection.id });
        await utils.collection.getAllUser.refetch();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to follow this collection',
          error: new Error(error.message),
        });
      },
    });

  const { isLoading: removingFollow, mutate: unfollowCollection } =
    trpc.collection.unfollow.useMutation({
      async onSuccess() {
        await utils.collection.getById.invalidate({ id: collection.id });
        await utils.collection.getAllUser.refetch();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to follow this collection',
          error: new Error(error.message),
        });
      },
    });

  if ((!permissions.follow && !permissions.isContributor) || permissions.isOwner) {
    // For contributors, we will still make it possible to un-follow
    return null;
  }

  const isProcessing = creatingFollow || removingFollow;

  const followBtnLabel = (() => {
    if (isProcessing) {
      return 'processing...';
    }

    return permissions.isContributor ? 'Unfollow' : 'Follow';
  })();

  const FollowBtnIcon = (() => {
    if (isProcessing) {
      return IconProgress;
    }

    return permissions.isContributor ? IconMinus : IconPlus;
  })();

  return (
    <Button
      size="xs"
      pl={4}
      pr={8}
      {...btnProps}
      onClick={() => {
        if (permissions.isContributor) {
          unfollowCollection({ collectionId: collection.id });
        } else {
          followCollection({ collectionId: collection.id });
        }
      }}
    >
      <Group spacing={4} noWrap>
        <FollowBtnIcon size={18} />
        {followBtnLabel}
      </Group>
    </Button>
  );
};

type Props = {
  collection: NonNullable<CollectionByIdModel>;
  permissions: CollectionContributorPermissionFlags;
};

export { CollectionFollowAction };
