import {
  ActionIcon,
  Alert,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  TextInput,
  Text,
  Popover,
  Stack,
  Box,
  Divider,
} from '@mantine/core';
import { useDebouncedValue, getHotkeyHandler } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus, IconX } from '@tabler/icons';
import { useEffect, useMemo } from 'react';
import { useState } from 'react';
import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};
type PostTagsPickerProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: TagProps[];
  onChange?: (value: TagProps[]) => void;
  onAddTag?: (tag: TagProps) => void;
  onRemoveTag?: (tag: TagProps) => void;
};

export function PostTagsPicker({
  value = [],
  onChange,
  onAddTag,
  onRemoveTag,
  ...props
}: PostTagsPickerProps) {
  console.log({ tags: value });
  return (
    <Input.Wrapper {...props}>
      <Group mt={5} spacing="xs">
        {value.map((tag, index) => (
          <Alert
            key={index}
            radius="xl"
            py={4}
            pr="xs"
            sx={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
          >
            <Group spacing="xs">
              <Text>{tag.name}</Text>
              <ActionIcon
                size="xs"
                color="red"
                variant="outline"
                radius="xl"
                onClick={() => onRemoveTag?.(tag)}
              >
                <IconX size={14} />
              </ActionIcon>
            </Group>
          </Alert>
        ))}
        {value.length < 5 && (
          <TagPicker
            value={value}
            onPick={(tag) => {
              onAddTag?.(tag);
            }}
          />
        )}
      </Group>
    </Input.Wrapper>
  );
}

function TagPicker({ value, onPick }: { value?: TagProps[]; onPick: (tag: TagProps) => void }) {
  const { classes, cx } = useDropdownContentStyles();
  const [active, setActive] = useState<number>();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState<string>('');
  const [debounced] = useDebouncedValue(query, 300);

  const { data: tags, isLoading } = trpc.post.getTags.useQuery({ query: debounced });

  useEffect(() => {
    setActive(undefined);
  }, [tags, editing]);

  const label = query.length > 1 ? 'Recommended' : 'Trending';

  const handleUp = () => {
    if (!tags?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      if (active > 0) return active - 1;
      return active;
    });
  };

  const handleDown = () => {
    if (!tags?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      const lastIndex = tags.length - 1;
      if (active < lastIndex) return active + 1;
      return active;
    });
  };

  const handleEnter = () => {
    if (!tags?.length || active === undefined) {
      const exists = value?.find((x) => x.name === query);
      if (!exists) onPick({ name: query });
    } else {
      const selected = tags[active];
      const exists = value?.find((x) => x.name === selected.name);
      if (!exists) onPick(selected);
    }
    setEditing(false);
    setQuery('');
  };

  const handleClick = (index: number) => {
    if (!tags?.length) return;
    const selected = tags[index];
    const exists = value?.find((x) => x.name === selected.name);
    if (!exists) onPick(selected);
  };

  return (
    <Popover opened={editing && !!tags?.length} position="bottom-start" withArrow>
      <Popover.Target>
        <Alert
          radius="xl"
          py={4}
          onClick={() => setEditing(true)}
          sx={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
        >
          {!editing ? (
            <Group spacing={4}>
              <IconPlus size={16} />
              <Text>Tag</Text>
            </Group>
          ) : (
            <TextInput
              variant="unstyled"
              value={query}
              autoFocus
              onBlur={() => {
                setTimeout(() => {
                  setQuery('');
                  setEditing(false);
                }, 0);
              }}
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
        <Box style={{ width: 300 }}>
          <Text p="sm" weight={500}>
            {label} Tags
          </Text>
          <Divider />
          {!!tags?.length && (
            <Stack spacing={0}>
              {tags.map((tag, index) => (
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
                    {tag.rank?.postCountAllTimeRank ?? tag.rank?.postCountDayRank} posts
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
    background: 'red',
  },
}));
