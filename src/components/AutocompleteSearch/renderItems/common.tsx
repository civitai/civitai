import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Anchor, Center, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import type { IconBadgeProps } from '~/components/IconBadge/IconBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';

export const ViewMoreItem = forwardRef<HTMLDivElement, ComboboxItem>(({ value, ...props }, ref) => {
  return (
    <Center ref={ref} {...props} w="100%" key="view-more">
      <Anchor td="none">View more results</Anchor>
    </Center>
  );
});

ViewMoreItem.displayName = 'SearchItem';

export function ActionIconBadge(props: Omit<IconBadgeProps, 'color'>) {
  const colorScheme = useComputedColorScheme('dark');

  return <IconBadge color={colorScheme === 'dark' ? 'dark' : 'gray'} size="xs" {...props} />;
}
