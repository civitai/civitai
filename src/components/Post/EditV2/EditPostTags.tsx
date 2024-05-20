import {
  ActionIcon,
  Alert,
  Box,
  createStyles,
  Divider,
  Group,
  Loader,
  Popover,
  Stack,
  Text,
  TextInput,
  useMantineTheme,
} from '@mantine/core';
import { getHotkeyHandler, useClickOutside, useDebouncedValue, usePrevious } from '@mantine/hooks';
import { IconPlus, IconStar, IconX } from '@tabler/icons-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import { PostDetailEditable } from '~/server/services/post.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};

type EditPostTagsProps = {
  postId: number;
  tags: TagProps[];
  setTags: (cb: (post: TagProps[]) => TagProps[]) => void;
};
const EditPostTagsContext = createContext<EditPostTagsProps | null>(null);
const useEditPostTagsContext = () => {
  const context = useContext(EditPostTagsContext);
  if (!context) throw new Error('missing EditPostTagsProvider');
  return context;
};

export function EditPostTags({ post }: { post: PostDetailEditable }) {
  const [tags, setTags] = useState<TagProps[]>(post.tags);
  const handleSetTags = (cb: (tags: TagProps[]) => TagProps[]) => setTags(cb);
  return (
    <EditPostTagsContext.Provider value={{ postId: post.id, tags, setTags: handleSetTags }}>
      <Group spacing="xs">
        {tags.map((tag, index) => (
          <PostTag
            key={index}
            tag={tag}
            canRemove={post.publishedAt ? post.tags.length > 1 : true}
          />
        ))}
        {tags.length < POST_TAG_LIMIT && <TagPicker />}
      </Group>
    </EditPostTagsContext.Provider>
  );
}

function PostTag({ tag, canRemove }: { tag: TagProps; canRemove?: boolean }) {
  const { postId, tags, setTags } = useEditPostTagsContext();
  const theme = useMantineTheme();

  const previousTags = usePrevious(tags);
  const { mutate, isLoading } = trpc.post.removeTag.useMutation({
    onMutate({ tagId }) {
      setTags((tags) => tags.filter((x) => x.id !== tagId));
    },
    onError(error, tag) {
      if (previousTags) setTags(() => previousTags);
    },
  });

  const handleRemoveTag = (tag: TagProps) => {
    if (tag.id) {
      mutate({ id: postId, tagId: tag.id });
    } else {
      setTags((tags) => tags.filter((x) => x.name.toLowerCase() !== tag.name.toLowerCase()));
    }
  };

  return (
    <Alert
      radius="xl"
      color="gray"
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
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
  const { postId, tags, setTags } = useEditPostTagsContext();

  const { classes, cx, theme } = useDropdownContentStyles();
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

  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isFetching } = trpc.post.getTags.useQuery(
    { query: debounced, nsfwLevel: browsingLevel },
    { keepPreviousData: true }
  );

  // const test = trpc.tag.getAll.useQuery(
  //   {
  //     query: debounced,
  //     entityType: [TagTarget.Post],
  //     nsfwLevel: browsingLevel,
  //     sort: TagSort.MostPosts,
  //     include: ['nsfwLevel'],
  //   },
  //   { keepPreviousData: true }
  // );
  const { mutate } = trpc.post.addTag.useMutation({
    onSuccess: async (response) => {
      setTags((tags) => [...tags.filter((x) => !!x.id && x.id !== response.id), response]);
    },
    onError(error, tag) {
      setTags((tags) => tags.filter((x) => x.name !== tag.name));
      showErrorNotification({
        title: 'Failed to add tag',
        error: new Error(error.message),
        reason: 'Unable to add tag, please try again.',
      });
    },
  });

  const handleAddTag = (tag: TagProps) => {
    mutate({ id: postId, tagId: tag.id, name: tag.name });
    setTags((tags) => [...tags, tag]);
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
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
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
                  <Group spacing={4}>
                    <Text size="sm">{tag.name}</Text>
                    {tag.isCategory && <IconStar className={classes.categoryIcon} size={12} />}
                  </Group>
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
  categoryIcon: {
    strokeWidth: 0,
    fill: theme.colors.blue[6],
    marginTop: 1,
  },
}));
