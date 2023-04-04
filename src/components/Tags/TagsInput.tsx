import {
  ActionIcon,
  Autocomplete,
  Badge,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  UnstyledButton,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedState, useDisclosure } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus, IconX } from '@tabler/icons';
import { useMemo } from 'react';

import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};

type TagsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: TagProps[];
  onChange?: (value: TagProps[]) => void;
  target: TagTarget[];
};
// !important - output must remain in the format {id, name}[]
export function TagsInput({ value = [], onChange, target, ...props }: TagsInputProps) {
  value = Array.isArray(value) ? value : value ? [value] : [];
  const { classes } = useStyles();
  const [search, setSearch] = useDebouncedState<string>('', 300);
  const [adding, { open, close }] = useDisclosure(false);

  const { data, isFetching } = trpc.tag.getAll.useQuery({
    limit: 10,
    entityType: target,
    query: search.trim().toLowerCase(),
  });

  const handleAddTag = (item: { id?: number; value: string }) => {
    const updated = [...value, { id: item.id, name: item.value }];
    onChange?.(updated);
    setSearch('');
    close();
  };
  const handleRemoveTag = (index: number) => {
    const updated = [...value];
    updated.splice(index, 1);
    onChange?.(updated);
  };

  const selectedTags = useMemo(() => value.map((tag) => tag.name), [value]);
  const isNewTag = search && !selectedTags.includes(search.trim().toLowerCase());

  return (
    <Input.Wrapper {...props}>
      <Group mt={5}>
        {value.map((tag, index) => (
          <Badge
            key={tag.id ?? index}
            size="xs"
            sx={{ paddingRight: 5 }}
            rightSection={
              <ActionIcon
                size="xs"
                color="blue"
                radius="xl"
                variant="transparent"
                onClick={() => handleRemoveTag(index)}
              >
                <IconX />
              </ActionIcon>
            }
          >
            {tag.name}
          </Badge>
        ))}
        <Badge
          // size="lg"
          radius="xs"
          className={classes.badge}
          classNames={{ inner: classes.inner }}
          onClick={!adding ? open : undefined}
          tabIndex={0}
          onKeyDown={
            !adding
              ? getHotkeyHandler([
                  ['Enter', open],
                  ['Space', open],
                ])
              : undefined
          }
          leftSection={
            adding && (
              <Center>
                <IconPlus />
              </Center>
            )
          }
        >
          {adding ? (
            <Autocomplete
              variant="unstyled"
              classNames={{ dropdown: classes.dropdown }}
              data={
                data?.items
                  ?.filter((tag) => !selectedTags.includes(tag.name))
                  .map((tag) => ({
                    id: tag.id,
                    value: tag.name,
                    group: !search ? 'Trending tags' : undefined,
                  })) ?? []
              }
              onChange={setSearch}
              onKeyDown={getHotkeyHandler([
                [
                  'Enter',
                  () => {
                    if (!isNewTag) return;
                    const exisiting =
                      data && data.items.find((tag) => tag.name === search.trim().toLowerCase());
                    handleAddTag({ id: exisiting?.id, value: exisiting?.name ?? search });
                  },
                ],
              ])}
              nothingFound={
                isFetching ? (
                  'Searching...'
                ) : isNewTag ? (
                  <UnstyledButton
                    className={classes.createOption}
                    onClick={() => handleAddTag({ value: search })}
                  >
                    {`+ Create tag "${search}"`}
                  </UnstyledButton>
                ) : (
                  'Nothing found'
                )
              }
              placeholder="Type to search..."
              onItemSubmit={handleAddTag}
              onBlur={() => {
                close();
                setSearch('');
              }}
              withinPortal
              autoFocus
            />
          ) : (
            <IconPlus />
          )}
        </Badge>
      </Group>
    </Input.Wrapper>
  );
}

const useStyles = createStyles((theme) => ({
  badge: {
    textTransform: 'none',
    cursor: 'pointer',
  },
  inner: {
    display: 'flex',
  },
  createOption: {
    fontSize: theme.fontSizes.sm,
    padding: theme.spacing.xs,
    borderRadius: theme.radius.sm,

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
    },
  },
  dropdown: {
    maxWidth: '300px !important',
  },
}));
