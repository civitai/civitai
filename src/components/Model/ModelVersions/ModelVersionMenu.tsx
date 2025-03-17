import { Button, Menu, useMantineTheme } from '@mantine/core';
import {
  IconBan,
  IconDotsVertical,
  IconEdit,
  IconPhotoEdit,
  IconPhotoPlus,
  IconTrash,
  IconFileSettings,
  IconCloudX,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { useRouter } from 'next/router';
import { showErrorNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';

export function ModelVersionMenu({
  modelVersionId,
  modelId,
  postId,
  canDelete,
  active,
  published,
}: {
  modelVersionId: number;
  modelId: number;
  postId?: number;
  canDelete: boolean;
  active: boolean;
  published: boolean;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();

  const bustModelVersionCacheMutation = trpc.modelVersion.bustCache.useMutation();
  function handleBustCache() {
    bustModelVersionCacheMutation.mutate({ id: modelVersionId });
  }

  const deleteVersionMutation = trpc.modelVersion.delete.useMutation({
    async onMutate(payload) {
      await queryUtils.model.getById.cancel({ id: modelId });

      const previousData = queryUtils.model.getById.getData({ id: modelId });
      if (previousData) {
        const filteredVersions = previousData.modelVersions.filter((v) => v.id !== payload.id);

        queryUtils.model.getById.setData(
          { id: modelId },
          { ...previousData, modelVersions: filteredVersions }
        );
      }

      return { previousData };
    },
    async onSuccess() {
      const nextLatestVersion = queryUtils.model.getById.getData({ id: modelId })?.modelVersions[0];
      if (nextLatestVersion)
        router.replace(`/models/${modelId}?modelVersionId=${nextLatestVersion.id}`);
      dialogStore.closeById('delete-version');
    },
    onError(error, _variables, context) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to delete version',
        reason: error.message ?? 'An unexpected error occurred, please try again',
      });
      if (context?.previousData?.id)
        queryUtils.model.getById.setData({ id: context?.previousData?.id }, context?.previousData);
    },
  });

  const handleDeleteVersion = () => {
    dialogStore.trigger({
      id: 'delete-version',
      component: ConfirmDialog,
      props: {
        title: 'Delete Version',
        message:
          'Are you sure you want to delete this version? This action is destructive and cannot be reverted.',
        labels: { cancel: `No, don't delete it`, confirm: 'Delete Version' },
        confirmProps: { color: 'red', loading: deleteVersionMutation.isLoading },
        onConfirm: () => deleteVersionMutation.mutate({ id: modelVersionId }),
      },
    });
  };

  return (
    <Menu withinPortal>
      <Menu.Target>
        <Button
          variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
          px={4}
          color={active ? 'blue' : 'gray'}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          compact
        >
          <IconDotsVertical size={14} />
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {canDelete && (
          <Menu.Item
            color="red"
            icon={<IconTrash size={14} stroke={1.5} />}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleDeleteVersion();
            }}
          >
            Delete version
          </Menu.Item>
        )}
        {currentUser?.isModerator && published && (
          <Menu.Item
            color="yellow"
            icon={<IconBan size={14} stroke={1.5} />}
            onClick={() =>
              openContext('unpublishModel', {
                modelId: modelId,
                versionId: modelVersionId,
              })
            }
          >
            Unpublish as Violation
          </Menu.Item>
        )}
        {currentUser?.isModerator && (
          <Menu.Item
            icon={<IconCloudX size={14} stroke={1.5} />}
            color="yellow"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleBustCache();
            }}
          >
            Bust Cache
          </Menu.Item>
        )}

        <Menu.Item
          component={Link}
          href={`/models/${modelId}/model-versions/${modelVersionId}/edit`}
          icon={<IconEdit size={14} stroke={1.5} />}
        >
          Edit details
        </Menu.Item>
        <Menu.Item
          icon={<IconFileSettings size={14} stroke={1.5} />}
          onClick={(e) => {
            e.stopPropagation();
            triggerRoutedDialog({
              name: 'filesEdit',
              state: {
                modelVersionId: modelVersionId,
              },
            });
          }}
        >
          Manage files
        </Menu.Item>
        {postId ? (
          <Menu.Item
            component={Link}
            icon={<IconPhotoEdit size={14} stroke={1.5} />}
            onClick={(e) => e.stopPropagation()}
            href={`/posts/${postId}/edit`}
          >
            Manage images
          </Menu.Item>
        ) : (
          <Menu.Item
            component={Link}
            icon={<IconPhotoPlus size={14} stroke={1.5} />}
            onClick={(e) => e.stopPropagation()}
            href={`/models/${modelId}/model-versions/${modelVersionId}/wizard?step=3`}
          >
            Add images
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
