import {
  Input,
  InputWrapperProps,
  Autocomplete,
  Badge,
  createStyles,
  Group,
  Center,
  ActionIcon,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedState, useDisclosure } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus, IconX } from '@tabler/icons';

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

  //TODO.tags - default query trending tags
  const { data, isFetching } = trpc.tag.getAll.useQuery(
    { limit: 10, entityType: target, query: search.trim().toLowerCase() },
    { enabled: !!search.length }
  );

  const handleAddTag = (item: { id?: number; value: string }) => {
    const updated = [...value, { id: item.id, name: item.value }];
    onChange?.(updated);
    setSearch('');
  };
  const handleRemoveTag = (index: number) => {
    const updated = [...value];
    updated.splice(index, 1);
    onChange?.(updated);
  };

  return (
    <Input.Wrapper {...props}>
      <Group mt={5}>
        <Badge
          size="lg"
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
              data={data?.items?.map((tag) => ({ id: tag.id, value: tag.name })) ?? []}
              onChange={setSearch}
              nothingFound={isFetching ? 'Loading...' : 'Nothing found'}
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
        {value.map((tag, index) => (
          <Badge
            key={tag.id}
            size="lg"
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
      </Group>
    </Input.Wrapper>
  );
}

const useStyles = createStyles(() => ({
  badge: {
    textTransform: 'none',
    cursor: 'pointer',
  },
  inner: {
    display: 'flex',
  },
}));
