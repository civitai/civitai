import { Button, Paper, Stack } from '@mantine/core';
import { ReactRendererOptions } from '@tiptap/react';
import { SuggestionProps } from '@tiptap/suggestion';
import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

export const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];

    if (item) {
      props.command({ ...item, id: `mention:${item.id}` });
    }
  };

  const upHandler = () => {
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
  };

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [props.items]);

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
        {props.items.map((item, index) => (
          <Button
            key={index}
            variant={index === selectedIndex ? 'light' : 'subtle'}
            onClick={() => selectItem(index)}
            radius={0}
            styles={{ inner: { justifyContent: 'flex-start' } }}
          >
            {item.label}
          </Button>
        ))}
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
