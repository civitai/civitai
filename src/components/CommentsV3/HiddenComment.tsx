import { Button, Group, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import { useState } from 'react';

export function useHiddenCommentReveal(hidden: boolean | null | undefined) {
  const [revealed, setRevealed] = useState(false);
  return {
    concealed: !!hidden && !revealed,
    reveal: () => setRevealed(true),
    conceal: () => setRevealed(false),
  };
}

export function HiddenCommentAvatar({ size }: { size: number }) {
  return (
    <div className="flex items-center justify-center" style={{ width: size, height: size }}>
      <IconEyeOff size={16} className="text-dimmed" />
    </div>
  );
}

export function HiddenCommentLabel({ onShow }: { onShow: () => void }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" c="dimmed" fs="italic">
        Hidden comment
      </Text>
      <Button variant="subtle" size="compact-xs" color="gray" onClick={onShow}>
        Show
      </Button>
    </Group>
  );
}

export function HideAgainButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="subtle" radius="xl" size="compact-xs" color="gray" onClick={onClick}>
      Hide again
    </Button>
  );
}
