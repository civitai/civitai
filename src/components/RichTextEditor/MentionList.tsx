import { Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { ReactRendererOptions } from '@tiptap/react';
import { SuggestionProps } from '@tiptap/suggestion';
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { removeDuplicates } from '~/utils/array-helpers';

export const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery] = useDebouncedValue(props.query, 300);

  const {
    data = [],
    isLoading,
    isRefetching,
  } = trpc.user.getAll.useQuery({ query: debouncedQuery, limit: 5 }, { enabled: !!debouncedQuery });

  const items = useMemo(
    () =>
      removeDuplicates(
        [...props.items, ...data.map((item) => ({ id: item.id, label: item.username }))],
        'id'
      ),
    [data, props.items]
  );

  const selectItem = (index: number) => {
    const item = items[index];

    if (item) {
      props.command({ ...item, id: `mention:${item.id}` });
    }
  };

  const upHandler = () => {
    setSelectedIndex((selectedIndex + items.length - 1) % items.length);
  };

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }

      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }

      if (event.key === 'Enter') {
        enterHandler();
        return true;
      }

      return false;
    },
  }));

  return (
    <Paper radius="md" withBorder>
      <Stack spacing={0}>
        {items.length > 0
          ? items.map((item, index) => (
              <Button
                key={index}
                variant={index === selectedIndex ? 'light' : 'subtle'}
                onClick={() => selectItem(index)}
                radius={0}
                styles={{ inner: { justifyContent: 'flex-start' } }}
              >
                {item.label}
              </Button>
            ))
          : null}
        {(isLoading && debouncedQuery) || isRefetching ? (
          <Center p="sm">
            <Group spacing="sm" noWrap>
              <Loader size="sm" />
              <Text size="sm" color="dimmed">
                Fetching...
              </Text>
            </Group>
          </Center>
        ) : items.length === 0 ? (
          <Center p="sm">
            <Text size="sm" color="dimmed">
              No results
            </Text>
          </Center>
        ) : null}
      </Stack>
    </Paper>
  );
});
MentionList.displayName = 'MentionList';

type Props = SuggestionProps<{ id: string; label: string }> & {
  editor: ReactRendererOptions['editor'];
};

export type MentionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};
