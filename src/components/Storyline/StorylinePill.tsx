import { Badge, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowRight, IconChevronDown, IconRoute } from '@tabler/icons-react';
import clsx from 'clsx';
import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, MouseEventHandler, ReactElement } from 'react';

function storylineChapterLabel(depth: number) {
  return `Ch ${depth + 1}`;
}

/** Titles longer than this get a tooltip with the whole title. */
export const STORYLINE_CHIP_TITLE_CHARS = 28;

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

/** Forwards ref and props so a Menu.Target can wrap it. */
export const StorylinePill = forwardRef<
  HTMLButtonElement,
  {
    title: string;
    depth: number;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    className?: string;
    menu?: boolean;
  } & Omit<ComponentPropsWithoutRef<'button'>, 'title' | 'onClick' | 'className'>
>(function StorylinePill({ title, depth, onClick, className, menu, ...props }, ref) {
  return (
    <Badge
      {...props}
      ref={ref}
      component="button"
      type="button"
      variant="filled"
      color="violet"
      radius="xl"
      h={26}
      onClick={onClick}
      leftSection={<IconRoute size={14} stroke={2.5} />}
      rightSection={menu ? <IconChevronDown size={13} stroke={2.5} /> : undefined}
      className={clsx('max-w-[240px] cursor-pointer normal-case', className)}
      title={`Part of the storyline "${title}"`}
      aria-label={`Storyline: ${title}, chapter ${depth + 1}`}
      style={{ pointerEvents: 'auto' }}
      data-testid="storyline-pill"
    >
      <ChipLabel title={title} depth={depth} />
    </Badge>
  );
});

/**
 * Forwards its ref and props, so the map sheet's popover can anchor to it and wire its aria
 * attributes.
 */
export const StorylineModeChip = forwardRef<
  HTMLButtonElement,
  { title: string; depth: number; mapOpen: boolean; onToggleMap: () => void } & Omit<
    ComponentPropsWithoutRef<'button'>,
    'title'
  >
>(function StorylineModeChip({ title, depth, mapOpen, onToggleMap, className, ...props }, ref) {
  return (
    <UnstyledButton
      {...props}
      ref={ref}
      onClick={onToggleMap}
      className={clsx(
        'inline-flex h-9 min-w-0 max-w-[min(360px,calc(100vw-120px))] items-center gap-1.5 rounded-full bg-[var(--mantine-color-violet-6)] pl-3 pr-2.5 text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(121,80,242,.45)]',
        className
      )}
      aria-label={`Storyline ${title}, chapter ${depth + 1}. ${mapOpen ? 'Close' : 'Open'} the map`}
      aria-expanded={mapOpen}
      data-testid="storyline-mode-chip"
    >
      <IconRoute size={15} className="shrink-0" />
      <ChipLabel title={title} depth={depth} />
      <IconChevronDown
        size={14}
        className={clsx('shrink-0 transition-transform', mapOpen && 'rotate-180')}
      />
    </UnstyledButton>
  );
});

export function StorylineEntryChip({
  title,
  depth,
  onEnter,
  compact,
}: {
  title: string;
  depth: number;
  onEnter: () => void;
  /** A phone header shares its row with five icons; the label would leave the title no room. */
  compact?: boolean;
}) {
  return (
    <TitleTooltip title={title}>
      <UnstyledButton
        onClick={onEnter}
        className="inline-flex h-9 min-w-0 max-w-[min(360px,calc(100vw-120px))] items-center gap-1.5 rounded-full border border-solid border-white/25 bg-[rgba(20,21,23,.62)] pl-2.5 pr-1.5 text-[13px] font-semibold text-white backdrop-blur-md"
        style={{ pointerEvents: 'auto' }}
        aria-label={`Read the storyline ${title} from chapter ${depth + 1}`}
        data-testid="storyline-enter"
      >
        <IconRoute size={15} className="shrink-0 text-[var(--mantine-color-violet-3)]" />
        <ChipLabel title={title} depth={depth} />
        {compact ? (
          <IconArrowRight size={14} className="shrink-0" />
        ) : (
          <span className="ml-1 shrink-0 rounded-full bg-[var(--mantine-color-violet-6)] px-[9px] py-1 text-xs">
            Read the story
          </span>
        )}
      </UnstyledButton>
    </TitleTooltip>
  );
}
