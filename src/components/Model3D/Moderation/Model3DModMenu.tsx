import {
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Modal,
  NumberInput,
  Stack,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArchive,
  IconDotsVertical,
  IconLock,
  IconLockOpen,
  IconPhotoShield,
  IconRestore,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ToggleableFlag = 'tosViolation' | 'poi' | 'minor' | 'nsfw' | 'unlisted';

export type Model3DModMenuModel = {
  id: number;
  status: Model3DStatus;
  nsfw: boolean;
  tosViolation: boolean;
  poi: boolean;
  minor: boolean;
  unlisted: boolean;
  nsfwLevel: number;
  lockedProperties: string[];
};

/**
 * Mod-only single dropdown menu surfaced on the Model3D detail page header.
 * Matches the canonical pattern used by the regular Model detail page
 * (src/pages/models/[id]/[[...slug]].tsx) — one trigger, one Menu.Dropdown,
 * destructive confirms via `openConfirmModal`.
 *
 * Visibility — render gating is the parent's responsibility (`isModerator`).
 * The mutations themselves are also `moderatorProcedure`-guarded.
 */
export function Model3DModMenu({ model3d }: { model3d: Model3DModMenuModel }) {
  const queryUtils = trpc.useUtils();
  const [nsfwModalOpen, setNsfwModalOpen] = useState(false);
  const [nsfwLevelValue, setNsfwLevelValue] = useState<number | string>(model3d.nsfwLevel ?? 0);
  const [lockNsfwLevel, setLockNsfwLevel] = useState(
    (model3d.lockedProperties ?? []).includes('nsfwLevel')
  );

  const isDeleted = model3d.status === Model3DStatus.Deleted;
  const isUnpublished = model3d.status === Model3DStatus.Unpublished;
  const isPublished = model3d.status === Model3DStatus.Published;
  const lockedSet = new Set(model3d.lockedProperties ?? []);

  const invalidate = () => queryUtils.model3d.getById.invalidate({ id: model3d.id });

  const onError = (action: string) => (error: { message: string }) => {
    showErrorNotification({
      title: `Failed to ${action}`,
      error: new Error(error.message),
    });
  };

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

  const submitNsfwLevel = () => {
    const parsed =
      typeof nsfwLevelValue === 'string' ? parseInt(nsfwLevelValue, 10) : nsfwLevelValue;
    if (!Number.isFinite(parsed) || parsed < 0) {
      showErrorNotification({
        title: 'Invalid NSFW level',
        error: new Error('NSFW level must be a non-negative integer.'),
      });
      return;
    }
    setNsfwLevelMutation.mutate({
      id: model3d.id,
      nsfwLevel: parsed as number,
      lock: lockNsfwLevel,
    });
  };

  const confirmUnpublish = () =>
    openConfirmModal({
      title: 'Unpublish 3D Model',
      children: 'Unpublish this 3D model? Owner can republish later.',
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
      children:
        'Soft-delete this 3D model? It can be restored later from the moderator tools.',
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
          <LegacyActionIcon
            variant="light"
            color="violet"
            size="lg"
            aria-label="Moderator actions"
            title="Moderator actions"
          >
            <IconDotsVertical size={20} />
          </LegacyActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            <Group gap={4} wrap="nowrap">
              <IconShieldCheck size={12} />
              <Text size="xs" fw={700} c="violet">
                Moderator
              </Text>
            </Group>
          </Menu.Label>

          {isPublished && (
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
          {!isDeleted && (
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
              <Badge size="xs" color="violet" variant="light">
                Lv {model3d.nsfwLevel}
                {lockedSet.has('nsfwLevel') ? ' • locked' : ''}
              </Badge>
            }
            onClick={() => {
              setNsfwLevelValue(model3d.nsfwLevel ?? 0);
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
        </Menu.Dropdown>
      </Menu>

      <Modal
        opened={nsfwModalOpen}
        onClose={() => setNsfwModalOpen(false)}
        title="Set NSFW Level"
        centered
        size="sm"
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Override the computed NSFW level. Locking prevents auto-recompute from changing it
            back.
          </Text>
          <NumberInput
            label="NSFW Level"
            description="Bitwise NSFW level value"
            value={nsfwLevelValue}
            onChange={(v) => setNsfwLevelValue(v ?? 0)}
            min={0}
            step={1}
            allowDecimal={false}
          />
          <Checkbox
            label="Lock (skip auto-recompute)"
            checked={lockNsfwLevel}
            onChange={(e) => setLockNsfwLevel(e.currentTarget.checked)}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setNsfwModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitNsfwLevel} loading={setNsfwLevelMutation.isLoading}>
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
