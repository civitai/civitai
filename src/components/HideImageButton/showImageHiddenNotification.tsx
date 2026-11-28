import { Button, Text } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { IconCheck } from '@tabler/icons-react';

const UNDO_WINDOW_MS = 8000;

export function showImageHiddenNotification({
  imageId,
  onUndo,
  noun = 'image',
}: {
  imageId: number;
  onUndo: () => void;
  /** What the hidden image is called, e.g. "song". */
  noun?: string;
}) {
  const id = `image-hidden-${imageId}`;
  showNotification({
    id,
    icon: <IconCheck size={18} />,
    color: 'teal',
    title: `${noun[0].toUpperCase()}${noun.slice(1)} hidden`,
    message: (
      <div>
        <Text inherit>This {noun} will not show up in your feed</Text>
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={() => {
            hideNotification(id);
            onUndo();
          }}
        >
          Undo
        </Button>
      </div>
    ),
    autoClose: UNDO_WINDOW_MS,
  });
}
