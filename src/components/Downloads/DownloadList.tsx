import { Stack, Text, MantineSize, Group, ActionIcon, Paper } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { DownloadGetAll } from '~/types/router';
import { slugit } from '~/utils/string-helpers';

export function DownloadList({ items, textSize = 'sm', onHideClick }: Props) {
  return (
    <Stack spacing="sm">
      {items.map((download) => {
        const downloadDate = dayjs(download.downloadAt);

        return (
          <Paper
            key={download.modelVersion.id}
            shadow="xs"
            p="md"
            radius="md"
            sx={(theme) => ({
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            })}
          >
            {/* Text and Info */}
            <Stack spacing={2} sx={{ flex: 1 }}>
              {/* Model Name */}
              <Link
                href={`/models/${download.modelVersion.model.id}/${slugit(
                  download.modelVersion.model.name
                )}`}
                passHref
                legacyBehavior
              >
                <Text component="a" weight={600} size="md" sx={{ lineHeight: 1.2 }}>
                  {download.modelVersion.model.name}
                </Text>
              </Link>

              {/* Model Version Name */}
              <Text size="sm" color="dimmed">
                {download.modelVersion.name}
              </Text>

              {/* Download Date */}
              <Text size="xs" color="dimmed">
                <abbr title={downloadDate.format()}>{downloadDate.fromNow()}</abbr>
              </Text>
            </Stack>

            {/* Delete Button */}
            <ActionIcon onClick={() => onHideClick(download)} radius="xl" color="red">
              <IconTrash size={16} />
            </ActionIcon>
          </Paper>
        );
      })}
    </Stack>
  );
}

type Props = {
  items: DownloadGetAll['items'];
  onHideClick: (download: DownloadGetAll['items'][number]) => void;
  textSize?: MantineSize;
  withDivider?: boolean;
};
