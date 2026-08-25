import { Anchor, Center, Group, Loader, Paper, Text, UnstyledButton } from '@mantine/core';
import { IconRepeat } from '@tabler/icons-react';
import type { ReactRendererOptions } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import clsx from 'clsx';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { blurbPreview, usesLabel } from '~/components/RichTextEditor/blurb.util';

type Props = SuggestionProps<BlurbItem> & {
  editor: ReactRendererOptions['editor'];
  loading?: boolean;
  onManage?: () => void;
};

export type BlurbListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

export const BlurbList = forwardRef<BlurbListRef, Props>(
  ({ items, command, query, loading, onManage }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      rowRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) command(item);
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev + items.length - 1) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev + 1) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (items.length > 0) {
            selectItem(selectedIndex);
            return true;
          }
        }
        return false;
      },
    }));

    return (
      <Paper className="z-50 w-[380px] max-w-full" radius="md" withBorder shadow="md">
        <Group
          gap={6}
          wrap="nowrap"
          className="border-0 border-b border-solid border-gray-3 px-3 py-2 dark:border-dark-4"
        >
          <IconRepeat size={13} stroke={1.5} className="text-gray-6 dark:text-dark-2" />
          <Text size="xs" fw={600} c="dimmed">
            {query ? `Blurbs matching “${query}”` : 'Blurbs'}
          </Text>
        </Group>

        {items.length === 0 ? (
          <Center p="sm">
            {loading ? (
              <Group gap={6} wrap="nowrap">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Loading blurbs…
                </Text>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                {query ? `No blurbs match "${query}"` : 'Nothing reusable yet'}
              </Text>
            )}
          </Center>
        ) : (
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5">
            {items.map((item, index) => {
              const isActive = index === selectedIndex;
              return (
                <UnstyledButton
                  key={item.id}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  className={clsx(
                    'flex flex-col gap-0.5 rounded-sm px-2.5 py-[7px]',
                    isActive && 'bg-blue-1 dark:bg-blue-8/20'
                  )}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => selectItem(index)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <Text size="sm" fw={600} c={isActive ? 'bright' : undefined} lineClamp={1}>
                      {item.name}
                    </Text>
                    <Text size="xs" c="dimmed" className="shrink-0">
                      {usesLabel(item.referenceCount)}
                    </Text>
                  </span>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {blurbPreview(item.content)}
                  </Text>
                </UnstyledButton>
              );
            })}
          </div>
        )}

        <Group
          gap={10}
          wrap="nowrap"
          className="border-0 border-t border-solid border-gray-3 px-3 py-2 dark:border-dark-4"
        >
          <Text size="xs" c="dimmed" className="flex-1">
            ↑↓ navigate · ↵ insert · esc dismiss
          </Text>
          {onManage && (
            <Anchor size="xs" fw={600} onClick={onManage}>
              Manage
            </Anchor>
          )}
        </Group>
      </Paper>
    );
  }
);

BlurbList.displayName = 'BlurbList';
