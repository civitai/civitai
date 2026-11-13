import type { ActionIconProps, PopoverProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import React from 'react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import type { ImageContextMenuProps } from '~/components/Image/ContextMenu/ImageMenuItems';
import { NeedsReviewBadge } from '~/components/Image/ContextMenu/NeedsReviewBadge';
import { ImageProvider } from '~/components/Image/ImageProvider';

// A menu taller than the room on either side (a moderator's, on a card low in the window) keeps to
// the side it opens on and scrolls inside, instead of running off the top or bottom of the window.
const fitInWindow: NonNullable<PopoverProps['middlewares']> = {
  flip: true,
  shift: true,
  size: {
    padding: 8,
    apply: ({ availableHeight, elements }) => {
      elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
    },
  },
};

export function ContextMenu({
  children,
  ...actionIconProps
}: { children: React.ReactNode } & ActionIconProps) {
  return (
    <Menu withinPortal withArrow zIndex={1000} middlewares={fitInWindow}>
      <Menu.Target>
        <ActionIconDotsVertical
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          {...actionIconProps}
        />
      </Menu.Target>
      {/* stopPropagation only. The dropdown portals out of the card, so the stop is what keeps the
          click off the card's link — while a preventDefault here also cancels the default action of
          anything inside, which silently breaks any `component="a"` item. */}
      <Menu.Dropdown className="flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Scrolls in here rather than on the dropdown, which would clip the arrow. */}
        <div data-context-menu-scroll className="min-h-0 overflow-y-auto">
          {children}
        </div>
      </Menu.Dropdown>
    </Menu>
  );
}

export function ImageContextMenuWrapper({
  image,
  children,
  className,
  ...props
}: { image: ImageContextMenuProps['image'] } & ActionIconProps) {
  return (
    <ImageProvider {...image}>
      {image.needsReview || image.ingestion === 'Blocked' ? (
        <Group gap={4} className={className}>
          <NeedsReviewBadge image={image} />
          <ContextMenu {...props}>{children}</ContextMenu>
        </Group>
      ) : (
        <ContextMenu className={className} {...props}>
          {children}
        </ContextMenu>
      )}
    </ImageProvider>
  );
}
