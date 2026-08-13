import { Card, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * A titled section of the image detail sidebar that can be folded away.
 *
 * The sidebar grew past what fits on a laptop — generation data alone can be a
 * full screen of resources and prompt — and the sticker work adds to it. Folding
 * is per section and remembered, so someone who never reads the prompt stops
 * scrolling past it on every image.
 *
 * Children are not rendered until the section is first open — the expensive ones
 * here are expensive because they query, and a hidden panel that still fetches
 * costs the same as an open one. After that first open they stay mounted and are
 * hidden with CSS: unmounting on collapse would throw away anything the reader
 * has typed into them, and Discussion contains the comment box.
 */
export function CollapsibleCard({
  title,
  icon,
  actions,
  storageKey,
  defaultOpen = true,
  rounded = true,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Sits beside the title and outside the toggle — a copy button in a button. */
  actions?: ReactNode;
  /** Distinct per section. Shared across images on purpose: the preference is
   * about the section, not about the image being looked at. */
  storageKey: string;
  defaultOpen?: boolean;
  rounded?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useLocalStorage({
    key: `image-detail-section:${storageKey}`,
    defaultValue: defaultOpen,
  });

  // Sticky once true: a section that has been opened stays mounted for the rest
  // of the page's life, so collapsing it costs the reader nothing they typed.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  const Chevron = open ? IconChevronUp : IconChevronDown;

  return (
    <Card className={clsx('flex flex-col gap-3', rounded ? 'rounded-xl' : 'rounded-none')}>
      {/* The whole row toggles, including the gap between the title and the
          chevron. It is a div rather than a button because `actions` holds a
          button of its own — the copy control — and a button inside a button is
          invalid markup that swallows its own click. So the row carries the
          role and the keyboard handling instead, and the actions stop the click
          from reaching it. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          // Space scrolls the sidebar otherwise, which on a collapse control is
          // the panel appearing to jump rather than to fold.
          event.preventDefault();
          setOpen((o) => !o);
        }}
        className="flex cursor-pointer select-none items-center gap-3"
      >
        <Text className="flex items-center gap-2 text-xl font-semibold">
          {icon}
          <span>{title}</span>
        </Text>
        {open && (
          <div
            onClick={(event) => event.stopPropagation()}
            // Keys too, not just clicks. The row toggles on Enter and Space, so
            // the first focusable control put in here would close the card out
            // from under whoever was using it.
            onKeyDown={(event) => event.stopPropagation()}
            className="flex items-center"
          >
            {actions}
          </div>
        )}
        <Chevron size={18} className="ml-auto shrink-0 opacity-60" />
      </div>
      {mounted && <div className={clsx('flex flex-col gap-3', !open && 'hidden')}>{children}</div>}
    </Card>
  );
}
