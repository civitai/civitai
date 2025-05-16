import {
  ActionIcon,
  Alert,
  Box,
  Divider,
  Group,
  Loader,
  Popover,
  Stack,
  Text,
  TextInput,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { getHotkeyHandler, useClickOutside, useDebouncedValue, usePrevious } from '@mantine/hooks';
import { IconPlus, IconStar, IconX } from '@tabler/icons-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import { PostDetailEditable } from '~/server/services/post.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './EditPostTags.module.scss';
import clsx from 'clsx';

type TagProps = {
  id?: number;
  name: string;
};

type EditPostTagsProps = {
  postId: number;
  tags: TagProps[];
  setTags: (cb: (post: TagProps[]) => TagProps[]) => void;
  autosuggest?: boolean;
};
const EditPostTagsContext = createContext<EditPostTagsProps | null>(null);
const useEditPostTagsContext = () => {
  const context = useContext(EditPostTagsContext);
  if (!context) throw new Error('missing EditPostTagsProvider');
  return context;
};

export function EditPostTags({
  post,
  autosuggest,
}: {
  post: PostDetailEditable;
  autosuggest?: boolean;
}) {
  const [tags, setTags] = useState<TagProps[]>(post.tags);
  const handleSetTags = (cb: (tags: TagProps[]) => TagProps[]) => setTags(cb);
  return (
    <EditPostTagsContext.Provider
      value={{ postId: post.id, tags, setTags: handleSetTags, autosuggest }}
    >
      <Group gap="xs">
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
  const colorScheme = useComputedColorScheme('dark');

  const previousTags = usePrevious(tags);
  const { mutate, isLoading } = trpc.post.removeTag.useMutation({
    onMutate({ tagId }) {
      setTags((tags) => tags.filter((x) => x.id !== tagId));
    },
    onError() {
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
      variant={colorScheme === 'dark' ? 'filled' : 'light'}
      py={4}
      pr={tag.id ? 'xs' : undefined}
      style={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
    >
      <Group gap="xs">
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
  const colorScheme = useComputedColorScheme('dark');
  const { postId, tags, setTags, autosuggest } = useEditPostTagsContext();

  const [active, setActive] = useState<number>();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState<string>('');
  const [debounced] = useDebouncedValue(query, 300);

  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);
  const [control, setControl] = useState<HTMLDivElement | null>(null);

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

  const handleAddTag = useCallback(
    (tag: TagProps) => {
      mutate({ id: postId, tagId: tag.id, name: tag.name });
      setTags((tags) => [...tags, tag]);
    },
    [mutate, postId, setTags]
  );

  useEffect(() => {
    setActive(undefined);
  }, [data, editing]);

  const label = query.length > 1 ? 'Recommended' : 'Trending';

  const filteredData = useMemo(
    () => data?.filter((x) => !tags.some((tag) => tag.name === x.name)) ?? [],
    [data, tags]
  );

  const handleUp = useCallback(() => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      if (active > 0) return active - 1;
      return active;
    });
  }, [filteredData?.length]);

  const handleClose = useCallback(() => {
    setEditing(false);
    setQuery('');
  }, []);

  const handleDown = useCallback(() => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      const lastIndex = filteredData.length - 1;
      if (active < lastIndex) return active + 1;
      return active;
    });
  }, [filteredData.length]);

  const handleEnter = useCallback(() => {
    if (!filteredData?.length || active === undefined) {
      const exists = tags?.find((x) => x.name === query);
      if (!exists) handleAddTag({ name: query });
    } else {
      const selected = filteredData[active];
      const exists = tags?.find((x) => x.name === selected.name);
      if (!exists) handleAddTag(selected);
    }
    handleClose();
  }, [active, filteredData, handleAddTag, handleClose, query, tags]);

  const handleClick = useCallback(
    (index: number) => {
      if (!filteredData?.length) return;
      const selected = filteredData[index];
      const exists = tags?.find((x) => x.name === selected.name);
      if (!exists) handleAddTag(selected);
      handleClose();
    },
    [filteredData, handleAddTag, handleClose, tags]
  );

  useClickOutside(handleClose, null, autosuggest ? [control, dropdown] : [control]);

  const target = useMemo(
    () => (
      <Alert
        radius="xl"
        py={4}
        color="gray"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        onClick={() => setEditing(true)}
        style={{ minHeight: 32, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
      >
        {!editing ? (
          <Group gap={4} data-tour="post:tag">
            <IconPlus size={16} />
            <Text>Tag</Text>
          </Group>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleEnter();
            }}
          >
            <TextInput
              ref={setControl}
              variant="unstyled"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={handleClose}
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
              autoFocus
            />
          </form>
        )}
      </Alert>
    ),
    [editing, handleClose, handleDown, handleEnter, handleUp, query, colorScheme]
  );

  if (!autosuggest) return target;

  return (
    <Popover opened={editing && !!filteredData?.length} position="bottom-start" shadow="lg">
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown p={0}>
        <Box style={{ width: 300 }} ref={setDropdown}>
          <Group justify="space-between" px="sm" py="xs">
            <Text weight={500}>{label} Tags</Text>
            {isFetching && <Loader variant="dots" />}
          </Group>
          <Divider />
          {!!filteredData?.length && (
            <Stack gap={0}>
              {filteredData.map((tag, index) => (
                <Group
                  justify="space-between"
                  key={index}
                  className={clsx({ [classes.active]: index === active })}
                  onMouseOver={() => setActive(index)}
                  onMouseLeave={() => setActive(undefined)}
                  onClick={() => handleClick(index)}
                  p="sm"
                >
                  <Group gap={4}>
                    <Text size="sm">{tag.name}</Text>
                    {tag.isCategory && <IconStar className={classes.categoryIcon} size={12} />}
                  </Group>
                  <Text size="sm" c="dimmed">
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
