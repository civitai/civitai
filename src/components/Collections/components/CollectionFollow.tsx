import type { ButtonProps } from '@mantine/core';
import { Button, Group } from '@mantine/core';
import { IconMinus, IconPlus, IconProgress } from '@tabler/icons-react';
import React from 'react';
import type { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCollection } from '~/components/Collections/collection.utils';

export const CollectionFollowAction = ({ collectionId, permissions, ...btnProps }: Props) => {
  const utils = trpc.useUtils();

  const { permissions: serverPermissions } = useCollection(collectionId);
  const mergedPermissions = { ...serverPermissions, ...permissions };

  const { isLoading: creatingFollow, mutate: followCollection } =
    trpc.collection.follow.useMutation({
      async onSuccess() {
        await utils.collection.getById.invalidate({ id: collectionId });
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
        await utils.collection.getById.invalidate({ id: collectionId });
        await utils.collection.getAllUser.refetch();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to unfollow this collection',
          error: new Error(error.message),
        });
      },
    });

  if (
    (!mergedPermissions.follow && !mergedPermissions.isContributor) ||
    mergedPermissions.isOwner
  ) {
    // For contributors, we will still make it possible to un-follow
    return null;
  }

  const isProcessing = creatingFollow || removingFollow;

  const followBtnLabel = (() => {
    if (isProcessing) {
      return 'processing...';
    }

    return mergedPermissions.isContributor ? 'Unfollow' : 'Follow';
  })();

  const FollowBtnIcon = (() => {
    if (isProcessing) {
      return IconProgress;
    }

    return mergedPermissions.isContributor ? IconMinus : IconPlus;
  })();

  return (
    <LoginRedirect reason="follow-collection">
      <Button
        size="xs"
        pl={4}
        pr={8}
        {...btnProps}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();

          if (mergedPermissions.isContributor) {
            unfollowCollection({ collectionId: collectionId });
          } else {
            followCollection({ collectionId: collectionId });
          }
        }}
      >
        <Group spacing={4} noWrap>
          <FollowBtnIcon size={18} />
          {followBtnLabel}
        </Group>
      </Button>
    </LoginRedirect>
  );
};

type Props = Omit<ButtonProps, 'onClick'> & {
  collectionId: number;
  permissions?: CollectionContributorPermissionFlags;
};
