import { Badge } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import clsx from 'clsx';
import type { MouseEventHandler } from 'react';

export function storylineChapterLabel(depth: number) {
  return `ch ${depth + 1}`;
}

export function StorylinePill({
  title,
  depth,
  onClick,
  className,
  withTitle = false,
}: {
  title: string;
  depth: number;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  withTitle?: boolean;
}) {
  return (
    <Badge
      component="button"
      type="button"
      variant="filled"
      color="violet"
      radius="xl"
      h={26}
      onClick={onClick}
      leftSection={<IconRoute size={14} stroke={2.5} />}
      className={clsx('cursor-pointer normal-case', className)}
      title={`Part of the storyline "${title}"`}
      aria-label={`Storyline: ${title}, chapter ${depth + 1}`}
      style={{ pointerEvents: 'auto' }}
      data-testid="storyline-pill"
    >
      Storyline{withTitle ? ` · ${title}` : ''} · {storylineChapterLabel(depth)}
    </Badge>
  );
}
