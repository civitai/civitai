import {
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  NumberInput,
  Popover,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconRestore,
  IconShield,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ToggleableFlag = 'tosViolation' | 'poi' | 'minor' | 'nsfw' | 'unlisted';

export type Model3DModBarModel = {
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
 * Mod-only horizontal action bar surfaced on the Model3D detail page header.
 * Backed by `trpc.model3d.moderation.*` (workstream O / plan §M2 Phase 3).
 *
 * Visibility — render gating is the parent's responsibility (`isModerator`).
 * The mutations themselves are also `moderatorProcedure`-guarded, so a
 * non-mod calling these directly would still 401.
 */
export function Model3DModBar({ model3d }: { model3d: Model3DModBarModel }) {
  const queryUtils = trpc.useUtils();
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

  const flagRows: Array<{ field: ToggleableFlag; label: string; value: boolean }> = [
    { field: 'nsfw', label: 'NSFW', value: model3d.nsfw },
    { field: 'tosViolation', label: 'TOS Violation', value: model3d.tosViolation },
    { field: 'poi', label: 'POI', value: model3d.poi },
    { field: 'minor', label: 'Minor', value: model3d.minor },
    { field: 'unlisted', label: 'Unlisted', value: model3d.unlisted },
  ];

  return (
    <Group gap={4} wrap="nowrap" align="center">
      <Badge
        color="violet"
        variant="light"
        leftSection={<IconShield size={12} />}
        size="sm"
        title="Moderator actions"
      >
        Mod
      </Badge>

      {/* Unpublish / Restore — depends on current status */}
      {isPublished && (
        <PopConfirm
          message="Unpublish this 3D model?"
          position="bottom-end"
          onConfirm={() => unpublishMutation.mutate({ id: model3d.id })}
          withArrow
          withinPortal
        >
          <Button
            size="xs"
            variant="default"
            leftSection={<IconArchive size={14} />}
            loading={unpublishMutation.isLoading}
          >
            Unpublish
          </Button>
        </PopConfirm>
      )}
      {(isUnpublished || isDeleted) && (
        <PopConfirm
          message={
            isDeleted
              ? 'Restore this 3D model to Unpublished?'
              : 'Restore this 3D model to Published?'
          }
          position="bottom-end"
          onConfirm={() => restoreMutation.mutate({ id: model3d.id })}
          withArrow
          withinPortal
        >
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRestore size={14} />}
            loading={restoreMutation.isLoading}
          >
            Restore
          </Button>
        </PopConfirm>
      )}

      {/* Delete (soft-delete) */}
      {!isDeleted && (
        <PopConfirm
          message="Soft-delete this 3D model? It can be restored later."
          position="bottom-end"
          confirmButtonColor="red"
          onConfirm={() => deleteMutation.mutate({ id: model3d.id })}
          withArrow
          withinPortal
        >
          <Button
            size="xs"
            color="red"
            variant="light"
            leftSection={<IconTrash size={14} />}
            loading={deleteMutation.isLoading}
          >
            Delete
          </Button>
        </PopConfirm>
      )}

      {/* Toggle flags dropdown */}
      <Menu shadow="md" position="bottom-end" withArrow withinPortal>
        <Menu.Target>
          <Button
            size="xs"
            variant="default"
            rightSection={<IconChevronDown size={12} />}
            loading={toggleFlagMutation.isLoading}
          >
            Flags
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Toggle moderation flag</Menu.Label>
          {flagRows.map((row) => {
            const locked = lockedSet.has(row.field);
            return (
              <Menu.Item
                key={row.field}
                leftSection={row.value ? <IconCheck size={14} /> : null}
                onClick={() => toggleFlagMutation.mutate({ id: model3d.id, field: row.field })}
              >
                <Group justify="space-between" gap="md" wrap="nowrap">
                  <Text size="xs">{row.label}</Text>
                  <Group gap={4}>
                    {locked && (
                      <Badge size="xs" color="gray" variant="outline">
                        locked
                      </Badge>
                    )}
                    <Badge
                      size="xs"
                      color={row.value ? 'red' : 'gray'}
                      variant={row.value ? 'filled' : 'light'}
                    >
                      {row.value ? 'on' : 'off'}
                    </Badge>
                  </Group>
                </Group>
              </Menu.Item>
            );
          })}
        </Menu.Dropdown>
      </Menu>

      {/* Set NSFW level — popover with NumberInput + Lock checkbox */}
      <Popover position="bottom-end" withArrow withinPortal shadow="md" width={220}>
        <Popover.Target>
          <Button size="xs" variant="default" rightSection={<IconChevronDown size={12} />}>
            NSFW Lv {model3d.nsfwLevel}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            <Text size="xs" fw={600}>
              Set NSFW Level
            </Text>
            <NumberInput
              size="xs"
              value={nsfwLevelValue}
              onChange={(v) => setNsfwLevelValue(v ?? 0)}
              min={0}
              step={1}
              allowDecimal={false}
              hideControls={false}
            />
            <Checkbox
              size="xs"
              label="Lock (skip auto-recompute)"
              checked={lockNsfwLevel}
              onChange={(e) => setLockNsfwLevel(e.currentTarget.checked)}
            />
            <Button size="xs" onClick={submitNsfwLevel} loading={setNsfwLevelMutation.isLoading}>
              Apply
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
