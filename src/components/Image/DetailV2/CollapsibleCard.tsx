import { Card, Text, UnstyledButton } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * A titled section of the image detail sidebar that can be folded away.
 *
 * The sidebar grew past what fits on a laptop — generation data alone can be a
 * full screen of resources and prompt — and the sticker work adds to it. Folding
 * is per section and remembered, so someone who never reads the prompt stops
 * scrolling past it on every image.
 *
 * A collapsed section renders no children at all rather than hiding them: the
 * expensive ones here are expensive because they query, and a hidden panel that
 * still fetches costs the same as an open one.
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

  const Chevron = open ? IconChevronUp : IconChevronDown;

  return (
    <Card className={clsx('flex flex-col gap-3', rounded ? 'rounded-xl' : 'rounded-none')}>
      <div className="flex items-center gap-3">
        {/* The title toggles and the chevron toggles; `actions` sits between
            them as a sibling. Putting them inside the toggle would nest a
            button in a button — the copy control here is one — which is invalid
            markup and swallows its own click. */}
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2"
        >
          <Text className="flex items-center gap-2 text-xl font-semibold">
            {icon}
            <span>{title}</span>
          </Text>
        </UnstyledButton>
        {open && actions}
        <UnstyledButton
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
          className="ml-auto flex items-center"
        >
          <Chevron size={18} className="shrink-0 opacity-60" />
        </UnstyledButton>
      </div>
      {open && children}
    </Card>
  );
}
