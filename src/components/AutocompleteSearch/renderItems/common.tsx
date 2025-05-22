import React, { forwardRef } from 'react';
import { Anchor, ComboboxItem, Center, useComputedColorScheme } from '@mantine/core';
import { IconBadge, IconBadgeProps } from '~/components/IconBadge/IconBadge';

export const ViewMoreItem = forwardRef<HTMLDivElement, ComboboxItem>(({ value, ...props }, ref) => {
  return (
    <Center ref={ref} {...props} key="view-more">
      <Anchor fw="bold" td="none !important">
        View more results
      </Anchor>
    </Center>
  );
});

ViewMoreItem.displayName = 'SearchItem';

export function ActionIconBadge(props: Omit<IconBadgeProps, 'color'>) {
  const colorScheme = useComputedColorScheme('dark');

  return <IconBadge color={colorScheme === 'dark' ? 'dark' : 'gray'} size="xs" {...props} />;
}
