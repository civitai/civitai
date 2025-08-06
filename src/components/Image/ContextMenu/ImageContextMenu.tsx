import type { ActionIconProps } from '@mantine/core';
import { useRouter } from 'next/router';
import React from 'react';
import {
  ImageMenuItems,
  type ImageContextMenuProps,
} from '~/components/Image/ContextMenu/ImageMenuItems';
import { ImageContextMenuWrapper } from '~/components/Image/ContextMenu/ContextMenu';

export function ImageContextMenu({
  context,
  additionalMenuItems,
  noDelete = false,
  image,
  children,
  ...actionIconProps
}: ImageContextMenuProps & ActionIconProps) {
  const router = useRouter();
  const props = {
    image,
    context,
    additionalMenuItems,
  };

  return (
    <ImageContextMenuWrapper image={image} {...actionIconProps}>
      <ImageMenuItems
        {...props}
        disableDelete={router.pathname.includes('/collections') || noDelete}
      />
    </ImageContextMenuWrapper>
  );
}
