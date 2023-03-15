import {
  ActionIcon,
  Alert,
  createStyles,
  Group,
  Input,
  TextInput,
  Text,
  Popover,
  Stack,
  Box,
  Divider,
  Loader,
  Center,
} from '@mantine/core';
import { useDebouncedValue, getHotkeyHandler, useClickOutside } from '@mantine/hooks';
import { IconPlus, IconX } from '@tabler/icons';
import { useEffect, useState, useMemo } from 'react';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};

export function EditPostTags() {
  const tags = useEditPostContext((state) => state.tags);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  return (
    <Input.Wrapper label="Tags">
      <Group mt={5} spacing="xs">
        {tags.map((tag, index) => (
          <PostTag key={index} tag={tag} canRemove={publishedAt ? tags.length > 1 : true} />
        ))}
        {tags.length < 5 && <TagPicker />}
      </Group>
    </Input.Wrapper>
  );
}

function PostTag({ tag, canRemove }: { tag: TagProps; canRemove?: boolean }) {
  const postId = useEditPostContext((state) => state.id);
  const setTags = useEditPostContext((state) => state.setTags);

  const { mutate, isLoading } = trpc.post.removeTag.useMutation({
    onMutate({ id }) {
      setTags((tags) => tags.filter((x) => x.id !== id));
    },
  });

  const handleRemoveTag = (tag: TagProps) => {
    if (tag.id) {
      mutate({ postId, id: tag.id }, { onError: () => setTags((tags) => [...tags, tag]) });
    } else {
      setTags((tags) => tags.filter((x) => x.name.toLowerCase() !== tag.name.toLowerCase()));
    }
  };

  return (
    <Alert
      radius="xl"
      py={4}
      pr={tag.id ? 'xs' : undefined}
      sx={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
    >
      <Group spacing="xs">
        <Text>{tag.name}</Text>
        {tag.id && canRemove && (
          <ActionIcon
            size="xs"
            variant="outline"
            radius="xl"
            onClick={() => handleRemoveTag(tag)}
            disabled={isLoading}
          >
            <IconX size={14} />
          </ActionIcon>
        )}
      </Group>
    </Alert>
  );
}

function TagPicker() {
  const postId = useEditPostContext((state) => state.id);
  const tags = useEditPostContext((state) => state.tags);
  const setTags = useEditPostContext((state) => state.setTags);

  const { classes, cx } = useDropdownContentStyles();
  const [active, setActive] = useState<number>();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState<string>('');
  const [debounced] = useDebouncedValue(query, 300);

  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);
  const [control, setControl] = useState<HTMLDivElement | null>(null);

  useClickOutside(
    () => {
      setQuery('');
      setEditing(false);
    },
    null,
    [control, dropdown]
  );

  const { data, isFetching } = trpc.post.getTags.useQuery(
    { query: debounced },
    { keepPreviousData: true }
  );
  const { mutate } = trpc.post.addTag.useMutation({
    onSuccess: async (response) => {
      setTags((tags) => {
        return [...tags.filter((x) => !!x.id && x.id !== response.id), response];
      });
    },
    onError: async () => {
      setTags((tags) => tags.filter((x) => !!x.id));
    },
  });

  const handleAddTag = (tag: TagProps) => {
    setTags((tags) => [...tags, tag]);
    mutate({ postId, ...tag });
  };

  useEffect(() => {
    setActive(undefined);
  }, [data, editing]);

  const label = query.length > 1 ? 'Recommended' : 'Trending';

  const filteredData = useMemo(
    () => data?.filter((x) => !tags.some((tag) => tag.name === x.name)) ?? [],
    [data, tags]
  );

  const handleUp = () => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      if (active > 0) return active - 1;
      return active;
    });
  };

  const handleDown = () => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      const lastIndex = filteredData.length - 1;
      if (active < lastIndex) return active + 1;
      return active;
    });
  };

  const handleEnter = () => {
    if (!filteredData?.length || active === undefined) {
      const exists = tags?.find((x) => x.name === query);
      if (!exists) handleAddTag({ name: query });
    } else {
      const selected = filteredData[active];
      const exists = tags?.find((x) => x.name === selected.name);
      if (!exists) handleAddTag(selected);
    }
    setEditing(false);
    setQuery('');
  };

  const handleClick = (index: number) => {
    if (!filteredData?.length) return;
    const selected = filteredData[index];
    const exists = tags?.find((x) => x.name === selected.name);
    if (!exists) handleAddTag(selected);
    setEditing(false);
    setQuery('');
  };

  return (
    <Popover opened={editing && !!filteredData?.length} position="bottom-start" shadow="lg">
      <Popover.Target>
        <Alert
          radius="xl"
          py={4}
          onClick={() => setEditing(true)}
          sx={{ minHeight: 32, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          {!editing ? (
            <Group spacing={4}>
              <IconPlus size={16} />
              <Text>Tag</Text>
            </Group>
          ) : (
            <TextInput
              ref={setControl}
              variant="unstyled"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              styles={{
                input: {
                  fontSize: 16,
                  padding: 0,
                  lineHeight: 1,
                  height: 'auto',
                  minHeight: 0,
                  minWidth: 42,
                  width: !query.length ? '1ch' : `${query.length}ch`,
                },
              }}
              onKeyDown={getHotkeyHandler([
                ['Enter', handleEnter],
                ['ArrowUp', handleUp],
                ['ArrowDown', handleDown],
              ])}
            />
          )}
        </Alert>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Box style={{ width: 300 }} ref={setDropdown}>
          <Group position="apart" px="sm" py="xs">
            <Text weight={500}>{label} Tags</Text>
            {isFetching && <Loader variant="dots" />}
          </Group>
          <Divider />
          {!!filteredData?.length && (
            <Stack spacing={0}>
              {filteredData.map((tag, index) => (
                <Group
                  position="apart"
                  key={index}
                  className={cx({ [classes.active]: index === active })}
                  onMouseOver={() => setActive(index)}
                  onMouseLeave={() => setActive(undefined)}
                  onClick={() => handleClick(index)}
                  p="sm"
                >
                  <Text size="sm">{tag.name}</Text>
                  <Text size="sm" color="dimmed">
                    {tag.postCount.toString()} posts
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}

const useDropdownContentStyles = createStyles((theme) => ({
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
    cursor: 'pointer',
  },
}));
