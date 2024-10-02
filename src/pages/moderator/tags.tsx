import {
  ActionIcon,
  Badge,
  Container,
  Group,
  Stack,
  Title,
  SelectItem,
  MantineColor,
  Tooltip,
  Text,
} from '@mantine/core';
import { TagsOnTagsType, TagTarget, TagType } from '@prisma/client';
import {
  IconAlbum,
  IconArrowMergeRight,
  IconBox,
  IconColumnInsertRight,
  IconPhoto,
  IconTag,
  IconTagOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { MantineReactTable, MRT_ColumnDef, MRT_SortingState } from 'mantine-react-table';
import { ActionIconSelect } from '~/components/ActionIconSelect/ActionIconSelect';
import { NextLink } from '@mantine/next';
import { ActionIconInput } from '~/components/ActionIconInput.tsx/ActionIconInput';
import { NotFound } from '~/components/AppLayout/NotFound';
import { openConfirmModal } from '@mantine/modals';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const tagColor: Record<TagsOnTagsType, MantineColor> = {
  Parent: 'gray',
  Replace: 'pink',
  Append: 'green',
};

export default function Tags() {
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  const [sorting, setSorting] = useState<MRT_SortingState>([]);

  const { data, isLoading } = trpc.tag.getManagableTags.useQuery();
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
    async onMutate({ tags: toAdd, entityIds, relationship }) {
      const isTagIds = typeof toAdd[0] === 'number';
      relationship ??= 'Parent';

      queryUtils.tag.getManagableTags.setData(undefined, (data) => {
        if (!data) return [];

        const toAddTags: any[] = [];
        for (const tag of toAdd) {
          if (isTagIds) {
            const tagData = addableTags.find((x) => x.id === tag);
            if (tagData) toAddTags.push({ ...tagData, relationship });
          } else {
            const tagData = addableTags.find((x) => x.name === tag);
            if (tagData) toAddTags.push({ ...tagData, relationship });
            else toAddTags.push({ name: tag, relationship });
          }
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

  const handleDisableTagOnEntity = (entityId: number, tag: number | string) =>
    disableTagMutation.mutate({
      tags: [tag] as number[] | string[],
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
        filterFn: 'contains',
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
        accessorFn: (x) => x.imageCount + x.modelCount + x.postCount,
        maxSize: 300,
        enableColumnActions: false,
        Cell: ({ row }) => {
          const tag = row.original;
          return (
            <Group noWrap spacing={5}>
              {tag.target.includes(TagTarget.Image) && (
                <NextLink href={`/images?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconPhoto size={14} />}>
                    {abbreviateNumber(tag.imageCount)}
                  </IconBadge>
                </NextLink>
              )}
              {tag.target.includes(TagTarget.Model) && (
                <NextLink href={`/models?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconBox size={14} />}>
                    {abbreviateNumber(tag.modelCount)}
                  </IconBadge>
                </NextLink>
              )}
              {tag.target.includes(TagTarget.Post) && (
                <NextLink href={`/posts?tags=${row.id}&view=feed`} target="_blank">
                  <IconBadge icon={<IconAlbum size={14} />}>
                    {abbreviateNumber(tag.postCount)}
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
                <Badge
                  key={t.id ?? t.name}
                  variant="filled"
                  color={tagColor[t.relationship]}
                  pr={0}
                >
                  <Group spacing={0}>
                    {t.name}
                    <ActionIcon
                      size="sm"
                      variant="transparent"
                      onClick={() => handleDisableTagOnEntity(tag.id, t.id ?? t.name)}
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
          console.log(filterValue);
          return row.original.tags.some((y) => y.name.startsWith(filterValue));
        },
      },
    ],
    [addableTagsOptions]
  );

  if (!features.moderateTags) return <NotFound />;

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
            const getSelectedName = () =>
              table.getSelectedRowModel().flatRows.map((x) => x.original.name);

            const handleDisableTagOnSelected = (tag: number) =>
              disableTagMutation.mutate({
                tags: [tag],
                entityIds: getSelected(),
                entityType: 'tag',
              });

            const handleAddTagToSelected = (tag: number | string, relationship: TagsOnTagsType) => {
              const selectedNames = getSelectedName();
              openConfirmModal({
                title: `Add Tag ${relationship}`,
                children: (
                  <Text size="sm">
                    Are you sure you want to add <strong>{tag}</strong> as a{' '}
                    <strong>{relationship}</strong> to {selectedNames.join(', ')}?
                  </Text>
                ),
                centered: true,
                labels: { confirm: 'Yes', cancel: 'No' },
                onConfirm: () => {
                  addTagMutation.mutate({
                    tags: [tag] as number[] | string[],
                    relationship,
                    entityIds: getSelected(),
                    entityType: 'tag',
                  });
                },
              });
            };

            const handleDeleteSelected = () =>
              deleteTagsMutation.mutate({
                tags: getSelected(),
              });

            return (
              <Group noWrap spacing="xs">
                <Tooltip label="Add parent">
                  <div>
                    <ActionIconSelect
                      items={addableTagsOptions}
                      onSelect={(id) => handleAddTagToSelected(id, 'Parent')}
                      withinPortal
                    >
                      <IconTag size="1.25rem" />
                    </ActionIconSelect>
                  </div>
                </Tooltip>
                <Tooltip label="Remove parent">
                  <div>
                    <ActionIconSelect
                      items={addableTagsOptions}
                      onSelect={(id) => handleDisableTagOnSelected(id)}
                      withinPortal
                    >
                      <IconTagOff size="1.25rem" />
                    </ActionIconSelect>
                  </div>
                </Tooltip>
                <Tooltip label="Replace with">
                  <div>
                    <ActionIconInput
                      onSubmit={(tag) => handleAddTagToSelected(tag, 'Replace')}
                      placeholder="Tag to replace with"
                      withinPortal
                    >
                      <IconArrowMergeRight size="1.25rem" />
                    </ActionIconInput>
                  </div>
                </Tooltip>
                <Tooltip label="Also append">
                  <div>
                    <ActionIconInput
                      onSubmit={(tag) => handleAddTagToSelected(tag, 'Append')}
                      placeholder="Tag to append"
                      withinPortal
                    >
                      <IconColumnInsertRight size="1.25rem" />
                    </ActionIconInput>
                  </div>
                </Tooltip>
                <Tooltip label="Delete">
                  <div>
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
                  </div>
                </Tooltip>
              </Group>
            );
          }}
        />
      </Stack>
    </Container>
  );
}
