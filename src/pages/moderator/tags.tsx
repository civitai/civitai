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
  SelectItem,
  Popover,
  Input,
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
import { ImageGetGalleryInfinite } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { MantineReactTable, MRT_ColumnDef, MRT_SortingState } from 'mantine-react-table';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ActionIconSelect } from '~/components/ActionIconSelect/ActionIconSelect';
import { NextLink } from '@mantine/next';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user?.isModerator || session.user?.bannedAt) {
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };
    }
  },
});

export default function Tags() {
  const queryUtils = trpc.useContext();
  const [tagSearch, setTagSearch] = useState('');
  const [selected, setSelected] = useState({});
  const [sorting, setSorting] = useState<MRT_SortingState>([]);

  const { data, isLoading, isRefetching, refetch } = trpc.tag.getManagableTags.useQuery();
  const tags = useMemo(() => data ?? [], [data]);
  const addableTags = useMemo(() => {
    if (!tags) return [];
    return tags
      .filter((x) => x.target.includes(TagTarget.Tag))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tags]);
  const addableTagsOptions = useMemo(() => {
    if (!addableTags) return [];
    return addableTags.map((x) => ({ label: x.name, value: x.id }));
  }, [addableTags]);

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

  const columns = useMemo<MRT_ColumnDef<(typeof tags)[number]>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        size: 150,
        enableColumnActions: false,
        filterFn: 'startsWith',
      },
      {
        id: 'type',
        header: 'Type',
        accessorFn: (x) => getDisplayName(x.type),
        enableSorting: false,
        enableColumnActions: false,
        maxSize: 150,
        filterFn: 'equals',
        filterVariant: 'select',
        mantineFilterSelectProps: {
          data: Object.values(TagType).map(
            (x) => ({ label: getDisplayName(x), value: getDisplayName(x) } as SelectItem)
          ) as any,
        },
      },
      {
        id: 'stats',
        header: 'Stats',
        accessorFn: (x) => x.stats.imageCount + x.stats.modelCount + x.stats.postCount,
        maxSize: 300,
        enableColumnActions: false,
        Cell: ({ row }) => {
          const tag = row.original;
          return (
            <Group noWrap spacing={5}>
              {tag.target.includes(TagTarget.Image) && (
                <NextLink href={`/images?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconPhoto size={14} />}>
                    {abbreviateNumber(tag.stats.imageCount)}
                  </IconBadge>
                </NextLink>
              )}
              {tag.target.includes(TagTarget.Model) && (
                <NextLink href={`/?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconBox size={14} />}>
                    {abbreviateNumber(tag.stats.modelCount)}
                  </IconBadge>
                </NextLink>
              )}
              {tag.target.includes(TagTarget.Post) && (
                <NextLink href={`/posts?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconAlbum size={14} />}>
                    {abbreviateNumber(tag.stats.postCount)}
                  </IconBadge>
                </NextLink>
              )}
            </Group>
          );
        },
        filterVariant: 'range',
        filterFn: 'betweenInclusive',
      },
      {
        id: 'labels',
        header: 'Labels',
        minSize: 500,
        enableSorting: false,
        enableColumnActions: false,
        accessorFn: (x) => x.tags,
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
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue.length) return true;
          if (!row.original.tags?.length) return false;
          return row.original.tags.some((x) => filterValue.includes(x.name));
        },
        filterVariant: 'select',
        mantineFilterSelectProps: {
          searchable: true,
          data: addableTagsOptions as any,
        },
      },
    ],
    [addableTagsOptions]
  );

  return (
    <Container size="xl">
      <Stack>
        <Stack spacing={0}>
          <Title order={1}>Tags</Title>
        </Stack>

        <MantineReactTable
          columns={columns}
          data={tags}
          enableSelectAll
          rowVirtualizerProps={{ overscan: 2 }} //optionally customize the row virtualizer
          enableRowSelection
          enableHiding={false}
          enableBottomToolbar={false}
          enableGlobalFilter={false}
          enablePagination={false}
          enableRowVirtualization
          mantineTableContainerProps={{ sx: { maxHeight: 'calc(100vh - 360px)' } }}
          onSortingChange={setSorting}
          initialState={{
            density: 'sm',
          }}
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
                <ActionIconSelect
                  items={addableTagsOptions}
                  onSelect={(id) => handleAddTagToSelected(id)}
                  withinPortal
                >
                  <IconTag size="1.25rem" />
                </ActionIconSelect>
                <ActionIconSelect
                  items={addableTagsOptions}
                  onSelect={(id) => handleDisableTagOnSelected(id)}
                  withinPortal
                >
                  <IconTagOff size="1.25rem" />
                </ActionIconSelect>
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
      </Stack>
    </Container>
  );
}
