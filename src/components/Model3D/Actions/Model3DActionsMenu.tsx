import {
  ActionIcon,
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
  IconAlertTriangle,
  IconArchive,
  IconBan,
  IconDotsVertical,
  IconFlag,
  IconPencil,
  IconPhotoShield,
  IconRadar2,
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
import { HideModel3DButton } from '~/components/HideModel3DButton/HideModel3DButton';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { useRescanImage } from '~/components/Image/hooks/useRescanImage';
import { useReportCsamImages } from '~/components/Image/image.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { NsfwLevel } from '~/server/common/enums';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';

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
   * When true, the trigger also renders for those users. Defaults to `true`
   * — the detail page folds Report into this menu (it no longer renders a
   * standalone Report icon). Card surfaces also surface Report inline.
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
  showReport = true,
  triggerSize = 'lg',
}: Model3DActionsMenuProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
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
  // Logged-in non-owner users (mod or not) can hide content from / block the
  // owner. Mods see these in addition to their mod tools — same as how the
  // image card menu surfaces them.
  const canHideUser = !!currentUser && !isOwner;
  // Render only when at least one section will have visible items. The card
  // surface enables the Report path for any logged-in user; the detail page
  // keeps the original owner/mod gate by leaving `showReport` false. The
  // hide-user / block-user items also satisfy this gate for any logged-in
  // non-owner viewer.
  if (!isOwner && !isModerator && !canReport && !canHideUser) return null;

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
  const setNsfwLevelMutation = trpc.model3d.moderation.setNsfwLevel.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'NSFW level updated' });
      await invalidate();
      setNsfwModalOpen(false);
    },
    onError: onError('set NSFW level'),
  });

  // Mod-only flag toggles. The router exposes a single endpoint keyed by
  // `field` (`tosViolation` / `poi` / `minor` / `nsfw` / `unlisted`) so we
  // wire one mutation and dispatch on click. Optimistic-cache busts: the
  // server's `setModel3DNsfwLevel` already refreshes the `getById` cache
  // tag; this path runs through `getInfinite` so we re-invalidate both.
  const toggleFlagMutation = trpc.model3d.moderation.toggleFlag.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Flag updated' });
      await invalidate();
    },
    onError: onError('toggle flag'),
  });

  // Thumbnail-Image-scoped mod helpers — both reuse the canonical Image
  // pipelines so behavior matches what mods are used to from the regular
  // image / model card menus.
  const rescanImage = useRescanImage();
  const reportCsamMutation = useReportCsamImages();
  const handleRescanThumbnail = () => {
    if (!model3d.thumbnailImageId) return;
    rescanImage({ imageId: model3d.thumbnailImageId });
  };
  const handleReportCsam = () => {
    if (!model3d.thumbnailImageId) return;
    if (features.csamReports) {
      window.open(
        `/moderator/csam/${model3d.userId}?imageId=${model3d.thumbnailImageId}`,
        '_blank'
      );
    } else {
      reportCsamMutation.mutate({ imageIds: [model3d.thumbnailImageId] });
    }
  };

  const confirmPublish = () =>
    openConfirmModal({
      title: 'Publish 3D Model',
      children: 'Publish this 3D model so others can discover and download it?',
      centered: true,
      labels: { confirm: 'Publish', cancel: 'Cancel' },
      confirmProps: { color: 'green', loading: publishMutation.isPending },
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
      confirmProps: { color: 'yellow', loading: unpublishMutation.isPending },
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
      confirmProps: { color: 'blue', loading: restoreMutation.isPending },
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
      confirmProps: { color: 'red', loading: deleteMutation.isPending },
      onConfirm: () => deleteMutation.mutate({ id: model3d.id }),
    });

  return (
    <>
      <Menu
        position="bottom-end"
        transitionProps={{ transition: 'pop-top-right' }}
        withinPortal
      >
        <Menu.Target>
          {/* Two trigger variants:
              - `sm` (card surface) mirrors the card's preview-eye button
                (`ActionIcon variant="filled" color="dark" radius="xl"`) so
                the row of icon buttons in the card header reads as a single
                visual group.
              - `md`/`lg` (detail page header) keep the canonical
                `LegacyActionIcon variant="light"` to match the Model detail
                page dropdown (src/pages/models/[id]/[[...slug]].tsx).
              In both cases we stop click propagation so the underlying
              card-as-link doesn't navigate. */}
          {triggerSize === 'sm' ? (
            <ActionIcon
              variant="filled"
              color="dark"
              radius="xl"
              size="sm"
              aria-label="Model actions"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <IconDotsVertical size={14} stroke={2} />
            </ActionIcon>
          ) : (
            <LegacyActionIcon
              variant="light"
              size={triggerSize}
              aria-label="Model actions"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <IconDotsVertical size={20} />
            </LegacyActionIcon>
          )}
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
              {/* Edit for mods lives in the Moderator section below — keeping
                  it in both sections would render two identical Edit rows when
                  the current user is both owner and mod. */}
              {(isDraft || isUnpublished) && (
                <Menu.Item
                  leftSection={<IconUpload size={14} stroke={1.5} />}
                  color="green"
                  onClick={confirmPublish}
                  disabled={publishMutation.isPending || !canPublish}
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
                  disabled={unpublishMutation.isPending}
                >
                  Unpublish
                </Menu.Item>
              )}
              {!isDeleted && (
                <Menu.Item
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  color="red.6"
                  onClick={confirmDelete}
                  disabled={deleteMutation.isPending}
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

              {!isOwner && (
                <Menu.Item
                  component={Link}
                  href={`/3d-models/${model3d.id}/edit`}
                  leftSection={<IconPencil size={14} stroke={1.5} />}
                >
                  Edit
                </Menu.Item>
              )}
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

              {/* Boolean flag toggles. The same endpoint that backs the
                  image card menu — one mutation keyed by `field`. */}
              <Menu.Item
                leftSection={<IconFlag size={14} stroke={1.5} />}
                onClick={() =>
                  toggleFlagMutation.mutate({ id: model3d.id, field: 'minor' })
                }
                disabled={toggleFlagMutation.isPending}
              >
                {model3d.minor ? 'Remove minor flag' : 'Flag as minor'}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconFlag size={14} stroke={1.5} />}
                onClick={() =>
                  toggleFlagMutation.mutate({ id: model3d.id, field: 'poi' })
                }
                disabled={toggleFlagMutation.isPending}
              >
                {model3d.poi ? 'Remove POI flag' : 'Flag as POI'}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconBan size={14} stroke={1.5} />}
                onClick={() =>
                  toggleFlagMutation.mutate({ id: model3d.id, field: 'tosViolation' })
                }
                disabled={toggleFlagMutation.isPending}
              >
                {model3d.tosViolation
                  ? 'Clear TOS Violation'
                  : 'Remove as TOS Violation'}
              </Menu.Item>

              {/* Thumbnail-scoped mod helpers. Disabled when the model
                  hasn't materialized its thumbnail yet (very fresh draft
                  before the polygen handler ingests the preview PNG). */}
              {model3d.thumbnailImageId && (
                <>
                  <Menu.Item
                    leftSection={<IconRadar2 size={14} stroke={1.5} />}
                    onClick={handleRescanThumbnail}
                  >
                    Rescan thumbnail image
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconAlertTriangle size={14} stroke={1.5} />}
                    onClick={handleReportCsam}
                  >
                    Report CSAM
                  </Menu.Item>
                </>
              )}
            </>
          )}

          {/* User-side hide/block + Report. The user-side items are
              available to any logged-in non-owner (mods see them too,
              alongside their mod tools). Report is gated to non-mod
              non-owner only — mods don't need to report a Model3D they
              can directly action. */}
          {canHideUser && (
            <>
              {(isOwner || isModerator) && <Menu.Divider />}
              <HideModel3DButton
                as="menu-item"
                model3dId={model3d.id}
                ownerUserId={model3d.userId}
              />
              <HideUserButton as="menu-item" userId={model3d.userId} />
              <BlockUserButton as="menu-item" userId={model3d.userId} />
            </>
          )}

          {canReport && (
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
              loading={setNsfwLevelMutation.isPending}
            >
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
