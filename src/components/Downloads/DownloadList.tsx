import { Stack, Text, MantineSize, Group, ActionIcon } from '@mantine/core';
import { IconTrash } from '@tabler/icons';
import dayjs from 'dayjs';
import Link from 'next/link';

import { DownloadGetAll } from '~/types/router';
import { slugit } from '~/utils/string-helpers';

export function DownloadList({ items, textSize = 'sm', onHideClick }: Props) {
  return (
    <Stack spacing={0}>
      {items.map((download) => {
        const downloadDate = dayjs(download.createdAt);

        return (
          <Group key={download.id} style={{ flexWrap: 'nowrap' }}>
            <Link href={`/models/${download.model.id}/${slugit(download.model.name)}`} passHref>
              <Text
                component="a"
                sx={(theme) => ({
                  flex: '1 !important',
                  padding: theme.spacing.sm,
                  ':hover': {
                    backgroundColor:
                      theme.colorScheme === 'dark'
                        ? theme.fn.lighten(theme.colors.dark[4], 0.05)
                        : theme.fn.darken(theme.colors.gray[0], 0.05),
                  },
                })}
              >
                <Stack spacing={0}>
                  <Text size={textSize} weight={500} lineClamp={2} sx={{ lineHeight: 1 }}>
                    {download.model.name}: {download.modelVersion.name}
                  </Text>
                  <Text size="xs" color="dimmed">
                    <abbr title={downloadDate.format()}>{downloadDate.fromNow()}</abbr>
                  </Text>
                </Stack>
              </Text>
            </Link>
            <ActionIcon onClick={() => onHideClick(download)} radius="xl" color="red">
              <IconTrash size={16} />
            </ActionIcon>
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
