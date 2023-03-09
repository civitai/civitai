import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  UnstyledButton,
  TextInput,
  Text,
  Popover,
} from '@mantine/core';
import {
  getHotkeyHandler,
  useDebouncedState,
  useDisclosure,
  useDebouncedValue,
  useClickOutside,
  useHotkeys,
} from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus, IconX } from '@tabler/icons';
import { useMemo } from 'react';
import { PostTag } from '~/server/selectors/post.selector';
import { Fragment, useState } from 'react';
import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};
type PostTagsPickerProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: TagProps[];
  onChange?: (value: TagProps[]) => void;
};

export function PostTagsPicker({ value = [], onChange, ...props }: PostTagsPickerProps) {
  return (
    <Input.Wrapper {...props}>
      <Group mt={5}>
        {value.map((tag, index) => (
          <Fragment key={index}></Fragment>
        ))}
        <TagPicker onPick={() => undefined} />
      </Group>
    </Input.Wrapper>
  );
}

function TagPicker({ onPick }: { onPick: (tag: TagProps) => void }) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState<string>('');
  const [debounced] = useDebouncedValue(query, 300);

  const { data, isLoading } = trpc.post.getTags.useQuery({ query: debounced });

  const label = query.length > 1 ? 'Recommended' : 'Trending';

  return (
    <Popover opened={editing && !!data?.length} position="bottom-start">
      <Popover.Target>
        <StyledTag onClick={() => setEditing(true)}>
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
                setQuery('');
                setEditing(false);
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
            />
          )}
        </StyledTag>
      </Popover.Target>
      <Popover.Dropdown>
        <Text>{label} Tags</Text>
      </Popover.Dropdown>
    </Popover>
  );
}

function StyledTag({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <Alert
      radius="xl"
      py={4}
      onClick={onClick}
      sx={{ minHeight: 32, display: 'flex', alignItems: 'center' }}
    >
      {children}
    </Alert>
  );
}

function DropdownContent({ tags }: { tags: TagProps[]; onSelect: (tag: TagProps) => void }) {
  useHotkeys([[]]);

  return <></>;
}
