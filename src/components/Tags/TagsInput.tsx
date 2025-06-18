import type { InputWrapperProps } from '@mantine/core';
import { Badge, Center, Group, Input, TextInput } from '@mantine/core';
import { getHotkeyHandler, useDisclosure } from '@mantine/hooks';
import type { TagTarget } from '~/shared/utils/prisma/enums';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useCallback, useMemo, useState } from 'react';
import styles from './TagsInput.module.scss';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

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
  const [search, setSearch] = useState('');
  const [adding, { open, close }] = useDisclosure(false);
  const trimmedSearch = search.trim().toLowerCase();

  const selectedTags = useMemo(() => value.map((tag) => tag.name), [value]);
  const isNewTag =
    !!trimmedSearch &&
    !selectedTags.includes(trimmedSearch) &&
    (filter?.({ name: trimmedSearch }) ?? true);

  const handleClose = useCallback(() => {
    close();
    setSearch('');
  }, [close]);

  const handleAddTag = useCallback(
    (item: { id?: number; value: string }) => {
      const updated = [...value, { id: item.id, name: item.value.trim().toLowerCase() }];
      onChange?.(updated);
      handleClose();
    },
    [handleClose, onChange, value]
  );

  const handleRemoveTag = (index: number) => {
    const updated = [...value];
    updated.splice(index, 1);
    onChange?.(updated);
  };

  const handleSubmit = useCallback(() => {
    if (!isNewTag) {
      handleClose();
      return;
    }

    if (trimmedSearch) handleAddTag({ value: trimmedSearch });
  }, [handleAddTag, handleClose, isNewTag, trimmedSearch]);

  return (
    <Input.Wrapper {...props}>
      <Group mt={5} gap={8}>
        {value.map((tag, index) => (
          <Badge
            key={tag.id ?? index}
            size="xs"
            style={{ paddingRight: 5 }}
            rightSection={
              <LegacyActionIcon
                size="xs"
                color="blue"
                radius="xl"
                variant="transparent"
                onClick={() => handleRemoveTag(index)}
              >
                <IconX size={12} />
              </LegacyActionIcon>
            }
          >
            {tag.name}
          </Badge>
        ))}
        <Badge
          // size="lg"
          // radius="xs"
          className={styles.badge}
          classNames={{ label: styles.inner }}
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
              onKeyDown={getHotkeyHandler([['Enter', handleSubmit]])}
              placeholder="Type your tag"
              onBlur={handleSubmit}
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

// const useStyles = createStyles((theme) => ({
//   badge: {
//     textTransform: 'none',
//     cursor: 'pointer',
//   },
//   inner: {
//     display: 'flex',
//   },
//   createOption: {
//     fontSize: theme.fontSizes.sm,
//     padding: theme.spacing.xs,
//     borderRadius: theme.radius.sm,

//     '&:hover': {
//       backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
//     },
//   },
//   dropdown: {
//     maxWidth: '300px !important',
//   },
// }));
