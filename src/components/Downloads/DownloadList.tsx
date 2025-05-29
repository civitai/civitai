import type { MantineSize } from '@mantine/core';
import { Stack, Text, Group, ActionIcon, lighten, darken, useMantineTheme, useComputedColorScheme } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import type { DownloadGetAll } from '~/types/router';
import { slugit } from '~/utils/string-helpers';

export function DownloadList({ items, textSize = 'sm', onHideClick }: Props) {
  const theme = useMantineTheme();

  return (
    <Stack gap={0}>
      {items.map((download) => {
        const downloadDate = dayjs(download.downloadAt);

        return (
          <Group key={download.modelVersion.id} wrap="nowrap">
            <Link
              href={`/models/${download.modelVersion.model.id}/${slugit(
                download.modelVersion.model.name
              )}`}
              passHref
              legacyBehavior
            >
              <Text component="a" className="flex p-8 hover:bg-gray-1 dark:hover:bg-dark-4">
                <Stack gap={0}>
                  <Text size={textSize} fw={500} lineClamp={2} style={{ lineHeight: 1 }}>
                    {download.modelVersion.model.name}: {download.modelVersion.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    <abbr title={downloadDate.format()}>{downloadDate.fromNow()}</abbr>
                  </Text>
                </Stack>
              </Text>
            </Link>
            <LegacyActionIcon onClick={() => onHideClick(download)} radius="xl" color="red">
              <IconTrash size={16} />
            </LegacyActionIcon>
          </Group>
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
