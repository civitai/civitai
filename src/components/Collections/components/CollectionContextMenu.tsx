import { Menu, MenuProps } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconEdit, IconHome, IconPencil, IconTrash } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ToggleSearchableMenuItem } from '../../MenuItems/ToggleSearchableMenuItem';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { openReportModal } from '~/components/Dialog/dialog-registry';

export function CollectionContextMenu({
  collectionId,
  ownerId,
  permissions,
  children,
  mode,
  ...menuProps
}: Props) {
  const queryUtils = trpc.useContext();
  const router = useRouter();
  const currentUser = useCurrentUser();

  const atDetailsPage = router.pathname === '/collections/[collectionId]';
  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === ownerId;

  const deleteCollectionMutation = trpc.collection.delete.useMutation();
  const handleDeleteClick = () => {
    openConfirmModal({
      title: 'Delete collection',
      children:
        'Are you sure that you want to delete this collection? This action is destructive and cannot be reversed.',
      labels: { cancel: "No, don't delete it", confirm: 'Delete collection' },
      onConfirm: () =>
        deleteCollectionMutation.mutate(
          { id: collectionId },
          {
            async onSuccess() {
              showSuccessNotification({
                title: 'Collection deleted',
                message: 'Your collection has been deleted',
              });

              await queryUtils.collection.getInfinite.invalidate();
              await queryUtils.collection.getAllUser.invalidate();

              if (atDetailsPage) await router.push('/collections');
            },
            onError(error) {
              showErrorNotification({
                title: 'Failed to delete collection',
                error: new Error(error.message),
              });
            },
          }
        ),
      confirmProps: { color: 'red' },
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

  const isBookmarkCollection = mode === CollectionMode.Bookmark;

  return (
    <Menu {...menuProps} withArrow>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {!isBookmarkCollection && (isOwner || isMod) && (
          <>
            <Menu.Item
              color="red"
              icon={<IconTrash size={14} stroke={1.5} />}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteClick();
              }}
            >
              Delete collection
            </Menu.Item>
            <Menu.Item
              icon={<IconEdit size={14} stroke={1.5} />}
              onClick={(e) => {
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
            icon={<IconHome size={14} stroke={1.5} />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleCollectionHomeBlock();
            }}
          >
            {collectionHomeBlock ? 'Remove from my home' : 'Add to my home'}
          </Menu.Item>
        )}
        {!isBookmarkCollection && permissions?.manage && (
          <Link legacyBehavior href={`/collections/${collectionId}/review`} passHref>
            <Menu.Item component="a" icon={<IconPencil size={14} stroke={1.5} />}>
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
