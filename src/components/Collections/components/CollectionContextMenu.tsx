import type { MenuProps } from '@mantine/core';
import { Menu } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconEdit,
  IconHome,
  IconPencil,
  IconStar,
  IconStarOff,
  IconTrash,
} from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ToggleSearchableMenuItem } from '../../MenuItems/ToggleSearchableMenuItem';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { CollectionFollowAction } from './CollectionFollow';

type CollectionWithId = { id: number };

export function CollectionContextMenu({
  collectionId,
  ownerId,
  permissions,
  children,
  mode,
  ...menuProps
}: Props) {
  const queryUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const router = useRouter();
  const currentUser = useCurrentUser();

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === ownerId;

  const deleteCollectionMutation = trpc.collection.delete.useMutation({
    // Optimistically remove the deleted collection from every variant of
    // getAllUser cache (it's called with several input shapes across the app:
    // {permission: VIEW}, {permissions: [ADD, ADD_REVIEW], type}, etc.).
    // This prevents the /collections page's auto-redirect from picking the
    // just-deleted ID off a stale cache entry on the way out of the details
    // page.
    onMutate: async ({ id }) => {
      const queryKey = getQueryKey(trpc.collection.getAllUser);
      await queryClient.cancelQueries({ queryKey, exact: false });
      const snapshot = queryClient.getQueriesData<CollectionWithId[]>({
        queryKey,
        exact: false,
      });
      queryClient.setQueriesData<CollectionWithId[]>({ queryKey, exact: false }, (old) =>
        old?.filter((c) => c.id !== id)
      );
      return { snapshot };
    },
    onError: (_error, _vars, ctx) => {
      // Restore the pre-mutation cache so the deleted item reappears if the
      // server rejected the delete.
      ctx?.snapshot.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSettled: async () => {
      await queryUtils.collection.getAllUser.invalidate();
    },
  });

  const handleDeleteClick = () => {
    // Capture route info at click time so the redirect decision can't be
    // affected by route changes that happen while the dialog is open.
    const onDeletedCollectionPage =
      router.pathname.startsWith('/collections/[collectionId]') &&
      Number(router.query.collectionId) === collectionId;

    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete collection',
        message:
          'Are you sure that you want to delete this collection? This action is destructive and cannot be reversed.',
        labels: { cancel: "No, don't delete it", confirm: 'Delete collection' },
        confirmProps: { color: 'red' },
        // ConfirmDialog awaits this promise — the dialog stays open with a
        // loading spinner until the mutation completes, and only then
        // does the dialog close.
        onConfirm: async () => {
          try {
            await deleteCollectionMutation.mutateAsync({ id: collectionId });
          } catch (error) {
            showErrorNotification({
              title: 'Failed to delete collection',
              error: error instanceof Error ? error : new Error(String(error)),
            });
            return;
          }

          showSuccessNotification({
            title: 'Collection deleted',
            message: 'Your collection has been deleted',
          });

          // Cache for getAllUser is already updated optimistically in onMutate,
          // so /collections's auto-redirect will pick a non-deleted collection
          // (or fall through to the landing view if none remain).
          if (onDeletedCollectionPage) {
            await router.replace('/collections');
          }
          await queryUtils.collection.getInfinite.invalidate();
          await queryUtils.collection.getById.invalidate({ id: collectionId });
        },
      },
    });
  };

  // Using this query might be more performant all together as there is a high likelyhood
  // that it's been preloaded by the user.
  const { data: homeBlocks = [] } = trpc.homeBlock.getHomeBlocks.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  const collectionHomeBlock = useMemo(() => {
    if (!currentUser) {
      return null;
    }

    return homeBlocks.find((homeBlock) => {
      const metadata = homeBlock.metadata as HomeBlockMetaSchema;
      return metadata.collection?.id === collectionId && homeBlock.userId === currentUser.id;
    });
  }, [homeBlocks, collectionId, currentUser]);

  const createCollectionHomeBlock = trpc.homeBlock.createCollectionHomeBlock.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Home page has been updated',
        message: `This collection has been added to your home page`,
      });
      await queryUtils.homeBlock.getHomeBlocks.invalidate();
    },
  });
  const deleteHomeBlock = trpc.homeBlock.delete.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Home page has been updated',
        message: `Collection has been removed from your home page`,
      });
      await queryUtils.homeBlock.getHomeBlocks.invalidate();
    },
  });

  const onToggleCollectionHomeBlock = async () => {
    if (!collectionHomeBlock) {
      createCollectionHomeBlock.mutate({
        collectionId: collectionId,
      });
    } else {
      deleteHomeBlock.mutate({
        id: collectionHomeBlock.id,
      });
    }
  };

  const { data: featuredPool } = trpc.homeBlock.getFeaturedCollectionsPool.useQuery(undefined, {
    enabled: isMod,
    trpc: { context: { skipBatch: true } },
  });
  const isFeatured = featuredPool?.collections.some((c) => c.id === collectionId) ?? false;

  const addToFeatured = trpc.homeBlock.addCollectionToFeaturedPool.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Featured on homepage',
        message: 'Collection added to homepage featured pool',
      });
      await queryUtils.homeBlock.getFeaturedCollectionsPool.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to feature', error: new Error(error.message) });
    },
  });
  const removeFromFeatured = trpc.homeBlock.removeCollectionFromFeaturedPool.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Removed from homepage',
        message: 'Collection removed from homepage featured pool',
      });
      await queryUtils.homeBlock.getFeaturedCollectionsPool.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to remove',
        error: new Error(error.message),
      });
    },
  });

  const onToggleHomepageFeature = () => {
    if (isFeatured) removeFromFeatured.mutate({ collectionId });
    else addToFeatured.mutate({ collectionId });
  };

  const isBookmarkCollection = mode === CollectionMode.Bookmark;

  return (
    <Menu {...menuProps} withArrow>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {permissions && !permissions.isOwner && (
          <Menu.Item component="div">
            <CollectionFollowAction
              variant="transparent"
              collectionId={collectionId}
              permissions={permissions}
              p={0}
              pl={0}
              pr={0}
              py={0}
              h={14}
              w="100%"
              justify="flex-start"
              style={{
                display: 'flex',
                alignItems: 'start',
              }}
            />
          </Menu.Item>
        )}

        {!isBookmarkCollection && (isOwner || isMod) && (
          <>
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteClick();
              }}
            >
              Delete collection
            </Menu.Item>
            <Menu.Item
              leftSection={<IconEdit size={14} stroke={1.5} />}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                triggerRoutedDialog({ name: 'collectionEdit', state: { collectionId } });
              }}
            >
              Edit collection
            </Menu.Item>
          </>
        )}
        {currentUser && permissions?.read && (
          <Menu.Item
            leftSection={<IconHome size={14} stroke={1.5} />}
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleCollectionHomeBlock();
            }}
          >
            {collectionHomeBlock ? 'Remove from my home' : 'Add to my home'}
          </Menu.Item>
        )}
        {isMod && !isBookmarkCollection && (
          <Menu.Item
            leftSection={
              isFeatured ? (
                <IconStarOff size={14} stroke={1.5} />
              ) : (
                <IconStar size={14} stroke={1.5} />
              )
            }
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleHomepageFeature();
            }}
          >
            {isFeatured ? 'Remove from homepage featured' : 'Feature on homepage'}
          </Menu.Item>
        )}
        {!isBookmarkCollection && permissions?.manage && (
          <Link legacyBehavior href={`/collections/${collectionId}/review`} passHref>
            <Menu.Item component="a" leftSection={<IconPencil size={14} stroke={1.5} />}>
              Review items
            </Menu.Item>
          </Link>
        )}
        {!isOwner && (
          <ReportMenuItem
            label="Report collection"
            loginReason="report-content"
            onReport={() =>
              openReportModal({
                entityType: ReportEntity.Collection,
                // Explicitly cast to number because we know it's not undefined
                entityId: collectionId,
              })
            }
          />
        )}
        {!isBookmarkCollection && (
          <ToggleSearchableMenuItem
            entityType="Collection"
            entityId={collectionId}
            key="toggle-searchable-menu-item"
          />
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

type Props = MenuProps & {
  collectionId: number;
  ownerId: number;
  children: React.ReactNode;
  permissions?: CollectionContributorPermissionFlags;
  mode?: CollectionMode | null;
};
