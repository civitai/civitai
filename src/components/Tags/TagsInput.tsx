import {
  ActionIcon,
  Badge,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  TextInput,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedState, useDisclosure } from '@mantine/hooks';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

type TagProps = {
  id?: number;
  name: string;
};

type TagsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  target: TagTarget[];
  value?: TagProps[];
  onChange?: (value: TagProps[]) => void;
  filter?: (tag: TagProps) => boolean;
};
// !important - output must remain in the format {id, name}[]
export function TagsInput({ value = [], onChange, target, filter, ...props }: TagsInputProps) {
  value = Array.isArray(value) ? value : value ? [value] : [];
  const { classes } = useStyles();
  const [search, setSearch] = useState('');
  const [adding, { open, close }] = useDisclosure(false);
  const trimmedSearch = search.trim().toLowerCase();

  const handleAddTag = (item: { id?: number; value: string }) => {
    const updated = [...value, { id: item.id, name: item.value.trim().toLowerCase() }];
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
  const isNewTag =
    !!trimmedSearch &&
    !selectedTags.includes(trimmedSearch) &&
    (filter?.({ name: trimmedSearch }) ?? true);

  return (
    <Input.Wrapper {...props}>
      <Group mt={5} spacing={8}>
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
                <IconX size={12} />
              </ActionIcon>
            }
          >
            {tag.name}
          </Badge>
        ))}
        <Badge
          // size="lg"
          // radius="xs"
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
                <IconPlus size={14} />
              </Center>
            )
          }
        >
          {adding ? (
            <TextInput
              variant="unstyled"
              onChange={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={getHotkeyHandler([
                [
                  'Enter',
                  () => {
                    if (!isNewTag) {
                      close();
                      setSearch('');
                      return;
                    }

                    if (trimmedSearch) handleAddTag({ value: trimmedSearch });
                  },
                ],
              ])}
              placeholder="Type your tag"
              onBlur={() => {
                close();
                setSearch('');
              }}
              autoFocus
            />
          ) : (
            <IconPlus size={16} />
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
