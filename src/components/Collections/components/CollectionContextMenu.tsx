import { Menu, MenuProps } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconEdit, IconHome, IconPencil, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function CollectionContextMenu({
  collectionId,
  ownerId,
  canManage,
  children,
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

              if (atDetailsPage) await router.push('/collections');
              await queryUtils.collection.getInfinite.invalidate();
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
  const { data: homeBlocks = [] } = trpc.homeBlock.getHomeBlocks.useQuery();
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

  return (
    <Menu {...menuProps} withArrow>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
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
                console.log('open edit');
              }}
            >
              Edit collection
            </Menu.Item>
          </>
        )}
        {canManage && (
          <Link href={`/collections/${collectionId}/review`} passHref>
            <Menu.Item component="a" icon={<IconPencil size={14} stroke={1.5} />}>
              Review Items
            </Menu.Item>
          </Link>
        )}
        {!isOwner && (
          <ReportMenuItem
            label="Report collection"
            loginReason="report-content"
            onReport={() =>
              openContext('report', {
                entityType: ReportEntity.Collection,
                // Explicitly cast to number because we know it's not undefined
                entityId: collectionId,
              })
            }
          />
        )}
        {currentUser && (
          // TODO.PersonalizedHomePages: This is disabled for now until fully
          // implemented
          <Menu.Item
            icon={<IconHome size={14} stroke={1.5} />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleCollectionHomeBlock();
            }}
          >
            {collectionHomeBlock ? 'Remove from my home page' : 'Add to my home page'}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

type Props = MenuProps & {
  collectionId: number;
  ownerId: number;
  children: React.ReactNode;
  canManage?: boolean;
};
