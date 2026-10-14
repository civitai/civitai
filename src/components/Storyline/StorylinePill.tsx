import { Badge, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconRoute, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { MouseEventHandler, ReactElement } from 'react';

function storylineChapterLabel(depth: number) {
  return `Ch ${depth + 1}`;
}

/** Past this many characters a title truncates in a chip and shows whole in a tooltip. */
export const STORYLINE_CHIP_TITLE_CHARS = 28;

/** The title, giving way before the chapter does when it is long. */
function ChipLabel({ title, depth }: { title: string; depth: number }) {
  return (
    <span className="flex min-w-0">
      <span className="truncate" data-testid="storyline-pill-title">
        {title}
      </span>
      <span className="shrink-0 opacity-80">&nbsp;· {storylineChapterLabel(depth)}</span>
    </span>
  );
}

function TitleTooltip({ title, children }: { title: string; children: ReactElement }) {
  return (
    <Tooltip label={title} disabled={title.length <= STORYLINE_CHIP_TITLE_CHARS} withinPortal>
      {children}
    </Tooltip>
  );
}

/** A feed card's mark that its image is part of a storyline. */
export function StorylinePill({
  title,
  depth,
  onClick,
  className,
}: {
  title: string;
  depth: number;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
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
      className={clsx('max-w-[240px] cursor-pointer normal-case', className)}
      title={`Part of the storyline "${title}"`}
      aria-label={`Storyline: ${title}, chapter ${depth + 1}`}
      style={{ pointerEvents: 'auto' }}
      data-testid="storyline-pill"
    >
      <ChipLabel title={title} depth={depth} />
    </Badge>
  );
}

/**
 * In storyline mode, the reader's place: the storyline and chapter, which opens the map, and an
 * x that leaves the mode. It replaces the banner, so it is the only storyline chrome on the image.
 */
export function StorylineModeChip({
  title,
  depth,
  onOpenMap,
  onLeave,
}: {
  title: string;
  depth: number;
  onOpenMap: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="inline-flex h-[30px] max-w-[min(360px,calc(100vw-24px))] items-center rounded-full bg-[var(--mantine-color-violet-6)] text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(121,80,242,.45)]"
      style={{ pointerEvents: 'auto' }}
      data-testid="storyline-mode-chip"
    >
      <TitleTooltip title={title}>
        <UnstyledButton
          onClick={onOpenMap}
          className="flex h-full min-w-0 items-center gap-1.5 pl-[11px] pr-2 text-inherit"
          aria-label={`Storyline ${title}, chapter ${depth + 1}. Open the map`}
          data-testid="storyline-pill"
        >
          <IconRoute size={15} className="shrink-0" />
          <ChipLabel title={title} depth={depth} />
          <IconChevronDown size={14} className="shrink-0" />
        </UnstyledButton>
      </TitleTooltip>
      <span aria-hidden className="h-4 w-px shrink-0 bg-white/35" />
      <UnstyledButton
        onClick={onLeave}
        className="flex h-full shrink-0 items-center pl-[7px] pr-[9px] text-inherit"
        aria-label="Leave the storyline"
        data-testid="storyline-leave"
      >
        <IconX size={14} />
      </UnstyledButton>
    </div>
  );
}

/**
 * Outside storyline mode: an invitation on the image. It reads on any picture, so it is a dark
 * translucent chip, ending in the violet "Read the story" that enters the mode.
 */
export function StorylineEntryChip({
  title,
  depth,
  onEnter,
}: {
  title: string;
  depth: number;
  onEnter: () => void;
}) {
  return (
    <TitleTooltip title={title}>
      <UnstyledButton
        onClick={onEnter}
        className="inline-flex h-[30px] max-w-[min(360px,calc(100vw-24px))] items-center gap-1.5 rounded-full border border-solid border-white/25 bg-[rgba(20,21,23,.62)] pl-2.5 pr-1.5 text-[13px] font-semibold text-white backdrop-blur-md"
        style={{ pointerEvents: 'auto' }}
        aria-label={`Read the storyline ${title} from chapter ${depth + 1}`}
        data-testid="storyline-enter"
      >
        <IconRoute size={15} className="shrink-0 text-[var(--mantine-color-violet-3)]" />
        <ChipLabel title={title} depth={depth} />
        <span className="ml-1 shrink-0 rounded-full bg-[var(--mantine-color-violet-6)] px-[9px] py-1 text-xs">
          Read the story
        </span>
      </UnstyledButton>
    </TitleTooltip>
  );
}
