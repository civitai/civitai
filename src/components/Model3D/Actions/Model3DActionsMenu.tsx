import {
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Modal,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArchive,
  IconDotsVertical,
  IconFlag,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconPhotoShield,
  IconRestore,
  IconShieldCheck,
  IconTrash,
  IconUpload,
  IconUserCircle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import classes from '~/components/BrowsingLevel/SetBrowsingLevelModal.module.scss';
import {
  browsingLevels,
  browsingLevelLabels,
} from '~/shared/constants/browsingLevel.constants';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { NsfwLevel } from '~/server/common/enums';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';

type ToggleableFlag = 'tosViolation' | 'poi' | 'minor' | 'nsfw' | 'unlisted';

export type Model3DActionsMenuModel = {
  id: number;
  /** Used to determine isOwner gating. */
  userId: number;
  status: Model3DStatus;
  nsfw: boolean;
  tosViolation: boolean;
  poi: boolean;
  minor: boolean;
  unlisted: boolean;
  nsfwLevel: number;
  lockedProperties: string[];
  /** When null, the Publish action is disabled (matches the server-side gate). */
  thumbnailImageId?: number | null;
};

export type Model3DActionsMenuProps = {
  model3d: Model3DActionsMenuModel;
  /**
   * Show the "Report" item for logged-in non-owner non-moderator users.
   * When true, the trigger also renders for those users (otherwise the menu
   * is owner/mod-only — the detail page passes `false` because it already
   * surfaces a dedicated Report button alongside this menu).
   */
  showReport?: boolean;
  /** Mantine size for the trigger. Defaults to `'lg'` (detail-page sizing). */
  triggerSize?: 'sm' | 'md' | 'lg';
};

/**
 * Unified actions dropdown surfaced on the Model3D detail page header.
 * Mirrors the canonical Model dropdown (src/pages/models/[id]/[[...slug]].tsx):
 * one trigger, one Menu.Dropdown, owner actions on top, moderator actions in
 * a separately-labeled section below.
 *
 * Visibility — the trigger renders if the current user is the owner OR a
 * moderator. Menu items inside are then gated by the same checks (mutations
 * are also server-guarded with protectedProcedure/moderatorProcedure).
 */
export function Model3DActionsMenu({
  model3d,
  showReport = false,
  triggerSize = 'lg',
}: Model3DActionsMenuProps) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [nsfwModalOpen, setNsfwModalOpen] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<NsfwLevel>(
    (model3d.nsfwLevel as NsfwLevel) ?? 0
  );
  const [lockNsfwLevel, setLockNsfwLevel] = useState(
    (model3d.lockedProperties ?? []).includes('nsfwLevel')
  );

  const isOwner = !!currentUser && currentUser.id === model3d.userId;
  const isModerator = !!currentUser?.isModerator;
  const canReport = showReport && !!currentUser && !isOwner && !isModerator;
  // Render only when at least one section will have visible items. The card
  // surface enables the Report path for any logged-in user; the detail page
  // keeps the original owner/mod gate by leaving `showReport` false.
  if (!isOwner && !isModerator && !canReport) return null;

  const isDeleted = model3d.status === Model3DStatus.Deleted;
  const isUnpublished = model3d.status === Model3DStatus.Unpublished;
  const isPublished = model3d.status === Model3DStatus.Published;
  const isDraft = model3d.status === Model3DStatus.Draft;
  const lockedSet = new Set(model3d.lockedProperties ?? []);
  const canPublish = !!model3d.thumbnailImageId;

  const invalidate = async () => {
    await Promise.all([
      queryUtils.model3d.getById.invalidate({ id: model3d.id }),
      queryUtils.model3d.getInfinite.invalidate(),
    ]);
  };

  const onError = (action: string) => (error: { message: string }) => {
    showErrorNotification({
      title: `Failed to ${action}`,
      error: new Error(error.message),
    });
  };

  const publishMutation = trpc.model3d.publish.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: '3D model published' });
      await invalidate();
    },
    onError: onError('publish'),
  });
  const unpublishMutation = trpc.model3d.unpublish.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: '3D model unpublished' });
      await invalidate();
    },
    onError: onError('unpublish'),
  });
  const deleteMutation = trpc.model3d.delete.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: '3D model deleted' });
      await invalidate();
    },
    onError: onError('delete'),
  });

  const restoreMutation = trpc.model3d.moderation.restore.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: '3D model restored' });
      await invalidate();
    },
    onError: onError('restore'),
  });
  const toggleFlagMutation = trpc.model3d.moderation.toggleFlag.useMutation({
    onSuccess: async (_data, vars) => {
      showSuccessNotification({ message: `Toggled "${vars.field}"` });
      await invalidate();
    },
    onError: onError('toggle flag'),
  });
  const setNsfwLevelMutation = trpc.model3d.moderation.setNsfwLevel.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'NSFW level updated' });
      await invalidate();
      setNsfwModalOpen(false);
    },
    onError: onError('set NSFW level'),
  });

  const confirmPublish = () =>
    openConfirmModal({
      title: 'Publish 3D Model',
      children: 'Publish this 3D model so others can discover and download it?',
      centered: true,
      labels: { confirm: 'Publish', cancel: 'Cancel' },
      confirmProps: { color: 'green', loading: publishMutation.isLoading },
      onConfirm: () => publishMutation.mutate({ id: model3d.id }),
    });

  const confirmUnpublish = () =>
    openConfirmModal({
      title: 'Unpublish 3D Model',
      children: isOwner
        ? 'Unpublish this 3D model? You can republish it later.'
        : 'Unpublish this 3D model? Owner can republish later.',
      centered: true,
      labels: { confirm: 'Unpublish', cancel: 'Cancel' },
      confirmProps: { color: 'yellow', loading: unpublishMutation.isLoading },
      onConfirm: () => unpublishMutation.mutate({ id: model3d.id }),
    });

  const confirmRestore = () =>
    openConfirmModal({
      title: 'Restore 3D Model',
      children: isDeleted
        ? 'Restore this 3D model to Unpublished?'
        : 'Restore this 3D model to Published?',
      centered: true,
      labels: { confirm: 'Restore', cancel: 'Cancel' },
      confirmProps: { color: 'blue', loading: restoreMutation.isLoading },
      onConfirm: () => restoreMutation.mutate({ id: model3d.id }),
    });

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete 3D Model',
      children: isOwner
        ? 'Delete this 3D model? It will be soft-deleted and removed from your gallery.'
        : 'Soft-delete this 3D model? It can be restored later from the moderator tools.',
      centered: true,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      onConfirm: () => deleteMutation.mutate({ id: model3d.id }),
    });

  const flagRows: Array<{ field: ToggleableFlag; label: string; value: boolean }> = [
    { field: 'nsfw', label: 'NSFW', value: model3d.nsfw },
    { field: 'tosViolation', label: 'TOS Violation', value: model3d.tosViolation },
    { field: 'poi', label: 'POI', value: model3d.poi },
    { field: 'minor', label: 'Minor', value: model3d.minor },
    { field: 'unlisted', label: 'Unlisted', value: model3d.unlisted },
  ];

  return (
    <>
      <Menu
        position="bottom-end"
        transitionProps={{ transition: 'pop-top-right' }}
        withinPortal
      >
        <Menu.Target>
          {/* Canonical pattern from src/pages/models/[id]/[[...slug]].tsx
              — variant="light" with no color prop. The card surface uses
              `triggerSize="sm"` and the wrapping span swallows the click so
              the underlying card-as-link doesn't navigate. */}
          <LegacyActionIcon
            variant="light"
            size={triggerSize}
            aria-label="Model actions"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
            }}
          >
            <IconDotsVertical size={triggerSize === 'sm' ? 14 : 20} />
          </LegacyActionIcon>
        </Menu.Target>
        <Menu.Dropdown
          onClick={(e: React.MouseEvent) => {
            // Stop dropdown clicks from bubbling up to the card link wrapper.
            e.stopPropagation();
          }}
        >
          {isOwner && (
            <>
              <Menu.Label>
                <Group gap={4} wrap="nowrap">
                  <IconUserCircle size={12} />
                  <Text size="xs" fw={700}>
                    Owner
                  </Text>
                </Group>
              </Menu.Label>
              <Menu.Item
                component={Link}
                href={`/3d-models/${model3d.id}/edit`}
                leftSection={<IconPencil size={14} stroke={1.5} />}
              >
                Edit
              </Menu.Item>
              {(isDraft || isUnpublished) && (
                <Menu.Item
                  leftSection={<IconUpload size={14} stroke={1.5} />}
                  color="green"
                  onClick={confirmPublish}
                  disabled={publishMutation.isLoading || !canPublish}
                  title={
                    !canPublish ? 'A thumbnail image is required before publishing.' : undefined
                  }
                >
                  Publish
                </Menu.Item>
              )}
              {isPublished && (
                <Menu.Item
                  leftSection={<IconArchive size={14} stroke={1.5} />}
                  color="yellow"
                  onClick={confirmUnpublish}
                  disabled={unpublishMutation.isLoading}
                >
                  Unpublish
                </Menu.Item>
              )}
              {!isDeleted && (
                <Menu.Item
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  color="red.6"
                  onClick={confirmDelete}
                  disabled={deleteMutation.isLoading}
                >
                  Delete
                </Menu.Item>
              )}
            </>
          )}

          {isModerator && (
            <>
              {isOwner && <Menu.Divider />}
              <Menu.Label>
                <Group gap={4} wrap="nowrap">
                  <IconShieldCheck size={12} />
                  <Text size="xs" fw={700}>
                    Moderator
                  </Text>
                </Group>
              </Menu.Label>

              {!isOwner && isPublished && (
                <Menu.Item
                  leftSection={<IconArchive size={14} stroke={1.5} />}
                  color="yellow"
                  onClick={confirmUnpublish}
                >
                  Unpublish
                </Menu.Item>
              )}
              {(isUnpublished || isDeleted) && (
                <Menu.Item
                  leftSection={<IconRestore size={14} stroke={1.5} />}
                  color="blue"
                  onClick={confirmRestore}
                >
                  Restore
                </Menu.Item>
              )}
              {!isOwner && !isDeleted && (
                <Menu.Item
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  color="red.6"
                  onClick={confirmDelete}
                >
                  Delete
                </Menu.Item>
              )}

              <Menu.Divider />

              <Menu.Item
                leftSection={<IconPhotoShield size={14} stroke={1.5} />}
                rightSection={
                  <Badge size="xs" variant="light">
                    {browsingLevelLabels[model3d.nsfwLevel as keyof typeof browsingLevelLabels] ??
                      '?'}
                    {lockedSet.has('nsfwLevel') ? ' • locked' : ''}
                  </Badge>
                }
                onClick={() => {
                  setPendingLevel((model3d.nsfwLevel as NsfwLevel) ?? 0);
                  setLockNsfwLevel(lockedSet.has('nsfwLevel'));
                  setNsfwModalOpen(true);
                }}
              >
                Set NSFW Level…
              </Menu.Item>

              <Menu.Divider />

              <Menu.Label>Toggle flags</Menu.Label>
              {flagRows.map((row) => {
                const locked = lockedSet.has(row.field);
                return (
                  <Menu.Item
                    key={row.field}
                    leftSection={
                      locked ? (
                        <IconLock size={14} stroke={1.5} />
                      ) : (
                        <IconLockOpen size={14} stroke={1.5} />
                      )
                    }
                    rightSection={
                      <Badge
                        size="xs"
                        color={row.value ? 'red' : 'gray'}
                        variant={row.value ? 'filled' : 'light'}
                      >
                        {row.value ? 'on' : 'off'}
                      </Badge>
                    }
                    onClick={() =>
                      toggleFlagMutation.mutate({ id: model3d.id, field: row.field })
                    }
                    disabled={toggleFlagMutation.isLoading}
                  >
                    {row.label}
                  </Menu.Item>
                );
              })}
            </>
          )}

          {canReport && (
            <>
              <Menu.Item
                leftSection={<IconFlag size={14} stroke={1.5} />}
                color="red.6"
                onClick={() =>
                  openReportModal({
                    entityType: ReportEntity.Model3D,
                    entityId: model3d.id,
                  })
                }
              >
                Report
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      {/* NSFW level picker — same Paper + UnstyledButton pattern as the
          shared SetBrowsingLevelModal, so it visually matches the rest of
          the moderator surface. We reuse that component's stylesheet so
          the active/border/hover states are pixel-identical. */}
      <Modal
        opened={nsfwModalOpen}
        onClose={() => setNsfwModalOpen(false)}
        title="3D Model ratings"
        centered
        size="sm"
      >
        <Stack mt={4} gap="md">
          <Paper withBorder p={0} className={clsx(classes.root, classes.horizontal)}>
            {browsingLevels.map((level) => (
              <UnstyledButton
                key={level}
                p="md"
                w="100%"
                className={clsx('text-center', {
                  [classes.active]: pendingLevel === level,
                })}
                onClick={() => setPendingLevel(level)}
              >
                <Text fw={700}>{browsingLevelLabels[level]}</Text>
              </UnstyledButton>
            ))}
          </Paper>

          <Checkbox
            label="Lock (skip auto-recompute)"
            description="Prevents auto-recompute from changing this rating back."
            checked={lockNsfwLevel}
            onChange={(e) => setLockNsfwLevel(e.currentTarget.checked)}
          />

          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setNsfwModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                setNsfwLevelMutation.mutate({
                  id: model3d.id,
                  nsfwLevel: pendingLevel,
                  lock: lockNsfwLevel,
                })
              }
              loading={setNsfwLevelMutation.isLoading}
            >
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
