import { Button, Loader, Menu, useComputedColorScheme } from '@mantine/core';
import {
  IconBan,
  IconDotsVertical,
  IconEdit,
  IconPhotoEdit,
  IconPhotoPlus,
  IconTrash,
  IconFileSettings,
  IconCloudX,
  IconAi,
  IconShieldHalf,
  IconPlaylistX,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { useRouter } from 'next/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useToggleCheckpointCoverageMutation } from '~/components/Model/model.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { openUnpublishModal } from '~/components/Dialog/triggers/unpublish';
import { getModelUrl } from '~/utils/string-helpers';
import { PAID_ACCESS_REFUND_WINDOW_DAYS } from '~/server/utils/early-access-helpers';

export function ModelVersionMenu({
  modelVersionId,
  modelId,
  postId,
  canDelete,
  active,
  published,
  canGenerate,
  generationDisabled,
  showToggleCoverage,
}: {
  modelVersionId: number;
  modelId: number;
  postId?: number;
  canDelete: boolean;
  active: boolean;
  published: boolean;
  canGenerate: boolean;
  generationDisabled: boolean;
  showToggleCoverage: boolean;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();

  const bustModelVersionCacheMutation = trpc.modelVersion.bustCache.useMutation({
    onSuccess: () => showSuccessNotification({ message: 'Cache busted' }),
  });
  function handleBustCache() {
    bustModelVersionCacheMutation.mutate({ id: modelVersionId });
  }

  const enqueuNsfwLevelUpdateMutation = trpc.modelVersion.enqueueNsfwLevelUpdate.useMutation({
    onSuccess: () => showSuccessNotification({ message: 'Nsfw level update queued' }),
  });
  function handleEnqueueNsfwLevelUpdate() {
    enqueuNsfwLevelUpdateMutation.mutate({ id: modelVersionId });
  }

  const toggleGenerationDisabledMutation = trpc.generation.toggleGenerationDisabled.useMutation({
    onSuccess: () => queryUtils.model.getById.invalidate({ id: modelId }),
    onError: (error) =>
      showErrorNotification({
        title: 'Error updating resource availability',
        error: new Error(error.message),
      }),
  });

  // "Unblock" rather than "enable": clearing the flag only removes the moderator
  // block — coverage, status and base-model support still decide whether the
  // version can actually generate.
  const handleToggleGeneration = () => {
    const label = generationDisabled ? 'Unblock generation' : 'Block generation';
    dialogStore.trigger({
      id: 'toggle-generation-blocked',
      component: ConfirmDialog,
      props: {
        title: label,
        message: generationDisabled
          ? 'Removes the moderator block on this version. Whether it can actually generate still depends on coverage and base-model support.'
          : 'This version will be blocked from the generator for everyone. Existing generations are unaffected.',
        labels: { cancel: 'Cancel', confirm: label },
        confirmProps: { color: generationDisabled ? 'blue' : 'red' },
        // Error is surfaced by the mutation's onError — swallow the rejection so
        // the dialog still closes and clears its loading state.
        onConfirm: () =>
          toggleGenerationDisabledMutation.mutateAsync({ id: modelVersionId }).catch(() => null),
      },
    });
  };

  const { toggle, isPending: isLoading } = useToggleCheckpointCoverageMutation();
  const handleToggleCoverage = async ({
    modelId,
    versionId,
  }: {
    modelId: number;
    versionId: number;
  }) => {
    // Error is handled at the hook level
    await toggle({ id: modelId, versionId }).catch(() => null);
  };

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
      const modelData = queryUtils.model.getById.getData({ id: modelId });
      const nextLatestVersion = modelData?.modelVersions[0];
      if (nextLatestVersion)
        router.replace(
          getModelUrl({
            modelId,
            modelName: modelData?.name,
            modelVersionId: nextLatestVersion.id,
          })
        );
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

  const unpublishVersionMutation = trpc.modelVersion.unpublish.useMutation({
    async onSuccess() {
      await queryUtils.model.getById.invalidate({ id: modelId });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to unpublish version',
      });
    },
  });

  const handleUnpublishVersion = async () => {
    try {
      // staleTime 0: the cached figure is what the owner is consenting to move Buzz over, and a
      // purchase can land between opening the menu twice.
      const refund = await queryUtils.modelVersion.getEarlyAccessRefundRequirement.fetch(
        { id: modelVersionId },
        { staleTime: 0 }
      );
      const exemptNote =
        refund.exemptBuyerCount > 0
          ? ` ${refund.exemptBuyerCount} earlier buyer(s) bought more than ${PAID_ACCESS_REFUND_WINDOW_DAYS} days ago; they lose access to this version and are not refunded.`
          : '';

      if (refund.purchaseCount > 0) {
        dialogStore.trigger({
          id: 'unpublish-version-refund',
          component: ConfirmDialog,
          props: {
            title: 'Refund early access buyers',
            message: `${
              refund.buyerCount
            } member(s) bought access to this version in the last ${PAID_ACCESS_REFUND_WINDOW_DAYS} days. Unpublishing it now will refund them a total of ${refund.totalBuzz.toLocaleString()} Buzz from your account and revoke their access to it.${exemptNote} Do you want to continue?`,
            labels: { cancel: 'Cancel', confirm: 'Refund & Unpublish' },
            confirmProps: { color: 'yellow' },
            onConfirm: () =>
              unpublishVersionMutation.mutate({ id: modelVersionId, refundEarlyAccess: true }),
          },
        });
        return;
      }

      dialogStore.trigger({
        id: 'unpublish-version',
        component: ConfirmDialog,
        props: {
          title: 'Unpublish version',
          message:
            refund.exemptBuyerCount > 0
              ? `${refund.exemptBuyerCount} member(s) bought access to this version, all more than ${PAID_ACCESS_REFUND_WINDOW_DAYS} days ago. They lose access to it and are not refunded, and nothing is taken from your account. Do you want to continue?`
              : 'This version will be hidden from the model page and can be published again later. Do you want to continue?',
          labels: { cancel: 'Cancel', confirm: 'Unpublish' },
          confirmProps: { color: 'yellow' },
          onConfirm: () => unpublishVersionMutation.mutate({ id: modelVersionId }),
        },
      });
    } catch (error) {
      showErrorNotification({
        error: error as Error,
        title: 'Unable to check early access purchases',
      });
    }
  };

  const handleDeleteVersion = () => {
    dialogStore.trigger({
      id: 'delete-version',
      component: ConfirmDialog,
      props: {
        title: 'Delete Version',
        message:
          'Are you sure you want to delete this version? This action is destructive and cannot be reverted.',
        labels: { cancel: `No, don't delete it`, confirm: 'Delete Version' },
        confirmProps: { color: 'red', loading: deleteVersionMutation.isPending },
        onConfirm: () => deleteVersionMutation.mutate({ id: modelVersionId }),
      },
    });
  };

  return (
    <Menu withinPortal>
      <Menu.Target>
        <Button
          variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
          px={4}
          color={active ? 'blue' : 'gray'}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          size="compact-sm"
        >
          <IconDotsVertical size={14} />
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        {currentUser?.isModerator && (
          <Menu.Item
            leftSection={<IconShieldHalf size={14} stroke={1.5} />}
            color="yellow"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleEnqueueNsfwLevelUpdate();
            }}
          >
            Enqueue NsfwLevel Update
          </Menu.Item>
        )}
        {canDelete && (
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} stroke={1.5} />}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleDeleteVersion();
            }}
          >
            Delete version
          </Menu.Item>
        )}
        {!currentUser?.isModerator && published && (
          <Menu.Item
            color="yellow"
            leftSection={<IconPlaylistX size={14} stroke={1.5} />}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleUnpublishVersion();
            }}
          >
            Unpublish version
          </Menu.Item>
        )}
        {currentUser?.isModerator && published && (
          <Menu.Item
            color="yellow"
            leftSection={<IconBan size={14} stroke={1.5} />}
            onClick={() =>
              openUnpublishModal({
                props: {
                  modelId: modelId,
                  versionId: modelVersionId,
                },
              })
            }
          >
            Unpublish as Violation
          </Menu.Item>
        )}
        {currentUser?.isModerator && (
          <Menu.Item
            leftSection={<IconCloudX size={14} stroke={1.5} />}
            color="yellow"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleBustCache();
            }}
          >
            Bust Cache
          </Menu.Item>
        )}

        {currentUser?.isModerator && showToggleCoverage && features.impersonation && (
          <>
            <Menu.Item
              disabled={isLoading}
              leftSection={isLoading ? <Loader size="xs" /> : <IconAi size={14} stroke={1.5} />}
              color="yellow"
              onClick={() =>
                handleToggleCoverage({
                  modelId: modelId,
                  versionId: modelVersionId,
                })
              }
              closeMenuOnClick={false}
            >
              {canGenerate ? 'Remove from generation' : 'Add to generation'}
            </Menu.Item>
          </>
        )}

        {currentUser?.isModerator && (
          <Menu.Item
            disabled={toggleGenerationDisabledMutation.isPending}
            leftSection={
              toggleGenerationDisabledMutation.isPending ? (
                <Loader size="xs" />
              ) : (
                <IconPlaylistX size={14} stroke={1.5} />
              )
            }
            color="yellow"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleToggleGeneration();
            }}
          >
            {generationDisabled ? 'Unblock generation' : 'Block generation'}
          </Menu.Item>
        )}

        <Menu.Item
          component={Link}
          href={`/models/${modelId}/model-versions/${modelVersionId}/edit`}
          leftSection={<IconEdit size={14} stroke={1.5} />}
          className={!features.canWrite ? 'pointer-events-none' : undefined}
        >
          Edit details
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileSettings size={14} stroke={1.5} />}
          onClick={(e: React.MouseEvent) => {
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
            leftSection={<IconPhotoEdit size={14} stroke={1.5} />}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            href={`/posts/${postId}/edit`}
            className={!features.canWrite ? 'pointer-events-none' : undefined}
          >
            Manage images
          </Menu.Item>
        ) : (
          <Menu.Item
            component={Link}
            leftSection={<IconPhotoPlus size={14} stroke={1.5} />}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            href={`/models/${modelId}/model-versions/${modelVersionId}/wizard?step=3`}
          >
            Add images
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
