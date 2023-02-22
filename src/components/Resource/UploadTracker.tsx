import {
  ActionIcon,
  Divider,
  Group,
  Indicator,
  Popover,
  Progress,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconClearAll, IconCloudUpload, IconX } from '@tabler/icons';
import React from 'react';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';

export function UploadTracker() {
  const theme = useMantineTheme();
  const { items, abort } = useS3UploadStore();

  const uploadingItems = items.filter((item) => item.status === 'uploading');

  if (!uploadingItems.length) return null;

  const handleAbortAll = () => {
    uploadingItems.forEach((item) => abort(item.uuid));
  };

  return (
    <Popover width={400} position="bottom-end">
      <Popover.Target>
        <Indicator
          color="blue"
          label={uploadingItems.length}
          showZero={false}
          dot={false}
          size={16}
        >
          <ActionIcon>
            <IconCloudUpload />
          </ActionIcon>
        </Indicator>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Group position="apart" p="sm">
          <Text weight="bold" size="sm">
            Files
          </Text>
          <Tooltip label="Cancel all" position="left">
            <ActionIcon size="sm" onClick={handleAbortAll}>
              <IconClearAll />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Divider />
        <Stack spacing={8} p="sm" sx={{ overflow: 'auto', maxWidth: '100%', maxHeight: 250 }}>
          {uploadingItems.map(({ uuid, name, progress, speed, timeRemaining, status }) => (
            <Stack key={uuid} spacing="xs">
              <Group spacing="xs" noWrap>
                <Group noWrap>
                  <IconCloudUpload
                    color={
                      status === 'uploading'
                        ? theme.colors.blue[theme.fn.primaryShade()]
                        : undefined
                    }
                    size={20}
                  />
                </Group>
                <Text
                  size="sm"
                  weight={500}
                  lineClamp={1}
                  sx={{ flex: 1, display: 'inline-block' }}
                >
                  {name}
                </Text>

                <Tooltip label="Cancel upload" position="left">
                  <ActionIcon color="red" onClick={() => abort(uuid)}>
                    <IconX size={20} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Stack spacing={4} sx={{ flex: 1 }}>
                <Progress
                  size="xl"
                  radius="xs"
                  value={progress}
                  label={`${Math.floor(progress)}%`}
                  color={progress < 100 ? 'blue' : 'green'}
                  striped
                  animate
                />
                <Group position="apart" noWrap>
                  <Text color="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
                  <Text color="dimmed" size="xs">{`${formatSeconds(
                    timeRemaining
                  )} remaining`}</Text>
                </Group>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
