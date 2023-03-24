import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import { TagTarget, TagType } from '@prisma/client';
import {
  IconAlbum,
  IconBan,
  IconBox,
  IconCheck,
  IconInfoCircle,
  IconPhoto,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTag,
  IconTagOff,
  IconTrash,
  IconX,
} from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { ImageGetAllInfinite } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { MantineReactTable, MRT_ColumnDef, MRT_SortingState } from 'mantine-react-table';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  if (!session?.user?.isModerator || session.user?.bannedAt) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }
  return { props: {} };
};

const ADDABLE_TAG_TYPES: TagType[] = [TagType.Moderation, TagType.System];
export default function Tags() {
  const queryUtils = trpc.useContext();
  const [selected, setSelected] = useState({});
  const [sorting, setSorting] = useState<MRT_SortingState>([]);

  const { data, isLoading, isRefetching, refetch } = trpc.tag.getManagableTags.useQuery();
  const tags = useMemo(() => data ?? [], [data]);
  const addableTags = useMemo(() => {
    if (!tags) return [];
    return tags.filter((x) => ADDABLE_TAG_TYPES.includes(x.type));
  }, [tags]);

  const deleteTagsMutation = trpc.tag.deleteTags.useMutation({
    async onMutate({ tags }) {
      queryUtils.tag.getManagableTags.setData(undefined, (data) => {
        if (!data) return [];

        const isTagIds = typeof tags[0] === 'number';
        if (isTagIds) return data.filter((x) => !(tags as number[]).includes(x.id));
        else return data.filter((x) => !(tags as string[]).includes(x.name));
      });
    },
  });

  const disableTagMutation = trpc.tag.disableTags.useMutation({
    async onMutate({ tags: toDisable, entityIds }) {
      queryUtils.tag.getManagableTags.setData(undefined, (data) => {
        if (!data) return [];

        const isTagIds = typeof toDisable[0] === 'number';
        return data.map((tag) =>
          !entityIds.includes(tag.id)
            ? tag
            : {
                ...tag,
                tags: isTagIds
                  ? tag.tags.filter((x) => !(toDisable as number[]).includes(x.id))
                  : tag.tags.filter((x) => !(toDisable as string[]).includes(x.name)),
              }
        );
      });
    },
  });

  const addTagMutation = trpc.tag.addTags.useMutation({
    async onMutate({ tags: toAdd, entityIds }) {
      const isTagIds = typeof toAdd[0] === 'number';

      queryUtils.tag.getManagableTags.setData(undefined, (data) => {
        if (!data) return [];

        const toAddTags: typeof tags = [];
        for (const tag of addableTags) {
          if (isTagIds && (toAdd as number[]).includes(tag.id)) toAddTags.push(tag);
          else if (!isTagIds && (toAdd as string[]).includes(tag.name)) toAddTags.push(tag);
        }

        return data.map((tag) =>
          !entityIds.includes(tag.id)
            ? tag
            : {
                ...tag,
                tags: [...tag.tags, ...toAddTags],
              }
        );
      });
    },
  });

  const handleDisableTagOnEntity = (entityId: number, tag: number) =>
    disableTagMutation.mutate({
      tags: [tag],
      entityIds: [entityId],
      entityType: 'tag',
    });

  const handleClearAll = () => {
    setSelected([]);
  };

  const handleRefresh = () => {
    handleClearAll();
    refetch();
    showNotification({
      id: 'refreshing',
      title: 'Refreshing',
      message: 'Grabbing the latest data...',
      color: 'blue',
    });
  };

  const columns = useMemo<MRT_ColumnDef<(typeof data)[number]>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        size: 150,
      },
      {
        id: 'type',
        header: 'Type',
        accessorFn: (x) => getDisplayName(x.type),
        maxSize: 150,
      },
      {
        id: 'stats',
        header: 'Stats',
        maxSize: 300,
        Cell: ({ row }) => {
          const tag = row.original;
          return (
            <Group noWrap spacing={5}>
              {tag.target.includes(TagTarget.Image) && (
                <IconBadge icon={<IconPhoto size={14} />}>
                  {abbreviateNumber(tag.stats.imageCount)}
                </IconBadge>
              )}
              {tag.target.includes(TagTarget.Model) && (
                <IconBadge icon={<IconBox size={14} />}>
                  {abbreviateNumber(tag.stats.modelCount)}
                </IconBadge>
              )}
              {tag.target.includes(TagTarget.Post) && (
                <IconBadge icon={<IconAlbum size={14} />}>
                  {abbreviateNumber(tag.stats.postCount)}
                </IconBadge>
              )}
            </Group>
          );
        },
      },
      {
        id: 'labels',
        header: 'Labels',
        minSize: 500,
        Cell: ({ row }) => {
          const tag = row.original;
          return (
            <Group spacing={5}>
              {tag.tags.map((t) => (
                <Badge key={t.id} variant="filled" color="gray" pr={0}>
                  <Group spacing={0}>
                    {t.name}
                    <ActionIcon
                      size="sm"
                      variant="transparent"
                      onClick={() => handleDisableTagOnEntity(tag.id, t.id)}
                    >
                      <IconX strokeWidth={3} size=".75rem" />
                    </ActionIcon>
                  </Group>
                </Badge>
              ))}
            </Group>
          );
        },
      },
    ],
    []
  );

  return (
    <Container size="xl">
      <Stack>
        <Stack spacing={0} mb="lg">
          <Title order={1}>Tags</Title>
          <Text color="dimmed">These are tags used throughout the site.</Text>
        </Stack>

        <MantineReactTable
          columns={columns}
          data={tags}
          enableSelectAll
          rowVirtualizerProps={{ overscan: 5 }} //optionally customize the row virtualizer
          enableRowSelection
          enableBottomToolbar={false}
          enableGlobalFilterModes
          enablePagination={false}
          enableRowVirtualization
          mantineTableContainerProps={{ sx: { maxHeight: '600px' } }}
          onSortingChange={setSorting}
          state={{ isLoading, sorting }}
          getRowId={(x) => x.id?.toString()}
          renderTopToolbarCustomActions={({ table }) => {
            const getSelected = () =>
              table.getSelectedRowModel().flatRows.map((x) => x.original.id);

            const handleDisableTagOnSelected = (tag: number) =>
              disableTagMutation.mutate({
                tags: [tag],
                entityIds: getSelected(),
                entityType: 'tag',
              });

            const handleAddTagToSelected = (tag: number) =>
              addTagMutation.mutate({
                tags: [tag],
                entityIds: getSelected(),
                entityType: 'tag',
              });

            const handleDeleteSelected = () =>
              deleteTagsMutation.mutate({
                tags: getSelected(),
              });

            return (
              <Group noWrap spacing="xs">
                <Menu withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="outline">
                      <IconTag size="1.25rem" />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown mah={400} sx={{ overflow: 'auto' }}>
                    <Menu.Label>Add Tag</Menu.Label>
                    {addableTags.map((tag) => (
                      <Menu.Item key={tag.id} onClick={() => handleAddTagToSelected(tag.id)}>
                        {tag.name}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
                <Menu withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="outline">
                      <IconTagOff size="1.25rem" />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown mah={400} sx={{ overflow: 'auto' }}>
                    <Menu.Label>Remove Tag</Menu.Label>
                    {addableTags.map((tag) => (
                      <Menu.Item key={tag.id} onClick={() => handleDisableTagOnSelected(tag.id)}>
                        {tag.name}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
                <PopConfirm
                  message={`Are you sure you want to delete these tags?`}
                  position="bottom-end"
                  onConfirm={handleDeleteSelected}
                  withArrow
                  withinPortal
                >
                  <ActionIcon variant="outline" color="red">
                    <IconTrash size="1.25rem" />
                  </ActionIcon>
                </PopConfirm>
              </Group>
            );
          }}
        />

        {/* {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : tags.length ? (

          <Table striped highlightOnHover>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Type</th>
                <th>Stats</th>
                <th>Labels</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={tag.id}>
                  <td>
                    <Checkbox
                      checked={selected.includes(tag.id)}
                      onChange={(e) => handleSelect(tag.id, e.target.checked)}
                    />
                  </td>
                  <td>{tag.name}</td>
                  <td>{getDisplayName(tag.type)}</td>
                  <td>
                    <Group noWrap spacing={5}>
                      {tag.target.includes(TagTarget.Image) && (
                        <IconBadge icon={<IconPhoto size={14} />}>
                          {abbreviateNumber(tag.stats.imageCount)}
                        </IconBadge>
                      )}
                      {tag.target.includes(TagTarget.Model) && (
                        <IconBadge icon={<IconBox size={14} />}>
                          {abbreviateNumber(tag.stats.modelCount)}
                        </IconBadge>
                      )}
                      {tag.target.includes(TagTarget.Post) && (
                        <IconBadge icon={<IconAlbum size={14} />}>
                          {abbreviateNumber(tag.stats.postCount)}
                        </IconBadge>
                      )}
                    </Group>
                  </td>
                  <td>
                    <Group spacing={5}>
                      {tag.tags.map((t) => (
                        <Badge key={t.id} variant="filled" color="gray" pr={0}>
                          <Group spacing={0}>
                            {t.name}
                            <ActionIcon
                              size="sm"
                              variant="transparent"
                              onClick={() => handleDisableTagOnEntity(tag.id, t.id)}
                            >
                              <IconX strokeWidth={3} size=".75rem" />
                            </ActionIcon>
                          </Group>
                        </Badge>
                      ))}
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <NoContent mt="lg" message="There are no tags to manager" />
        )} */}
      </Stack>
    </Container>
  );
}
