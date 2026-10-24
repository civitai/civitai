import type { ActionIconProps } from '@mantine/core';
import { Group, Menu } from '@mantine/core';
import React from 'react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import type { ImageContextMenuProps } from '~/components/Image/ContextMenu/ImageMenuItems';
import { NeedsReviewBadge } from '~/components/Image/ContextMenu/NeedsReviewBadge';
import { ImageProvider } from '~/components/Image/ImageProvider';

export function ContextMenu({
  children,
  ...actionIconProps
}: { children: React.ReactNode } & ActionIconProps) {
  return (
    <Menu withinPortal withArrow zIndex={1000}>
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
      <Menu.Dropdown onClick={(e) => e.stopPropagation()}>{children}</Menu.Dropdown>
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
