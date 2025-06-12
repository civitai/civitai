import {
  ActionIcon,
  Divider,
  getPrimaryShade,
  Group,
  Indicator,
  Popover,
  Progress,
  Stack,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconClearAll, IconCloudUpload, IconX } from '@tabler/icons-react';
import React from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';

export function UploadTracker() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { items, abort } = useS3UploadStore();

  const uploadingItems = items.filter((item) => item.status === 'uploading');

  if (!uploadingItems.length) return null;

  const handleAbortAll = () => {
    uploadingItems.forEach((item) => abort(item.uuid));
  };

  return (
    <Popover width={400} position="bottom-end">
      <Popover.Target>
        <Indicator color="blue" label={uploadingItems.length} size={16}>
          <LegacyActionIcon>
            <IconCloudUpload />
          </LegacyActionIcon>
        </Indicator>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Group justify="space-between" p="sm">
          <Text fw="bold" size="sm">
            Files
          </Text>
          <Tooltip label="Cancel all" position="left">
            <LegacyActionIcon size="sm" onClick={handleAbortAll}>
              <IconClearAll />
            </LegacyActionIcon>
          </Tooltip>
        </Group>
        <Divider />
        <Stack gap={8} p="sm" style={{ overflow: 'auto', maxWidth: '100%', maxHeight: 250 }}>
          {uploadingItems.map(({ uuid, name, progress, speed, timeRemaining, status }) => (
            <Stack key={uuid} gap="xs">
              <Group gap="xs" wrap="nowrap">
                <IconCloudUpload
                  color={
                    status === 'uploading'
                      ? theme.colors.blue[getPrimaryShade(theme, colorScheme)]
                      : undefined
                  }
                  size={20}
                />
                <Text size="sm" fw={500} lineClamp={1} style={{ flex: 1, display: 'inline-block' }}>
                  {name}
                </Text>

                <Tooltip label="Cancel upload" position="left">
                  <LegacyActionIcon color="red" onClick={() => abort(uuid)}>
                    <IconX size={20} />
                  </LegacyActionIcon>
                </Tooltip>
              </Group>
              <Stack gap={4} style={{ flex: 1 }}>
                <Progress.Root size="xl" radius="xs">
                  <Progress.Section
                    value={progress}
                    color={progress < 100 ? 'blue' : 'green'}
                    striped
                    animated
                  >
                    <Progress.Label>{`${Math.floor(progress)}%`}</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
                <Group justify="space-between" wrap="nowrap">
                  <Text c="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
                  <Text c="dimmed" size="xs">{`${formatSeconds(timeRemaining)} remaining`}</Text>
                </Group>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
