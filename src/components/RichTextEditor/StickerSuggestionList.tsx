import { Center, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import type { SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { STICKER_SIZE } from '~/shared/utils/sticker-token';

export type StickerSuggestionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type Props = SuggestionProps<ResolvedSticker>;

export const StickerSuggestionList = forwardRef<StickerSuggestionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = props.items;

  useEffect(() => setSelectedIndex(0), [items]);

  const selectItem = (index: number) => {
    const item = items[index];
    if (item) props.command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (!items.length)
    return (
      <Paper className="relative z-50" radius="md" withBorder>
        <Center p="sm">
          <Text size="sm" c="dimmed">
            No stickers match
          </Text>
        </Center>
      </Paper>
    );

  return (
    <Paper className="relative z-50" radius="md" withBorder>
      <Stack gap={0}>
        {items.map((item, index) => (
          <UnstyledButton
            key={item.id}
            onClick={() => selectItem(index)}
            className={`flex items-center gap-2 px-3 py-1.5 ${
              index === selectedIndex ? 'bg-gray-1 dark:bg-dark-5' : ''
            }`}
          >
            <EdgeImage
              src={item.url}
              alt={`:${item.slug}:`}
              options={{ height: STICKER_SIZE.jumbo, anim: item.animated, optimized: true }}
              style={{ height: STICKER_SIZE.inline, width: 'auto', objectFit: 'contain' }}
            />
            <Text size="sm">:{item.slug}:</Text>
          </UnstyledButton>
        ))}
      </Stack>
    </Paper>
  );
});

StickerSuggestionList.displayName = 'StickerSuggestionList';
