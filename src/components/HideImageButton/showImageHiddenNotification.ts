import { Button, Text } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { IconCheck } from '@tabler/icons-react';
import { createElement } from 'react';

const UNDO_WINDOW_MS = 8000;

export function showImageHiddenNotification({
  imageId,
  onUndo,
}: {
  imageId: number;
  onUndo: () => void;
}) {
  const id = `image-hidden-${imageId}`;
  showNotification({
    id,
    icon: createElement(IconCheck, { size: 18 }),
    color: 'teal',
    title: 'Image hidden',
    message: createElement(
      'div',
      null,
      createElement(Text, { inherit: true }, 'This image will not show up in your feed'),
      createElement(
        Button,
        {
          size: 'compact-sm',
          variant: 'subtle',
          onClick: () => {
            hideNotification(id);
            onUndo();
          },
        },
        'Undo'
      )
    ),
    autoClose: UNDO_WINDOW_MS,
  });
}
