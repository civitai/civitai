import React, { forwardRef } from 'react';
import type { ComboboxItem } from '@mantine/core';
import { Group, Image, Text, ThemeIcon } from '@mantine/core';
import { IconUser } from '@tabler/icons-react';
import { ViewMoreItem } from '~/components/AutocompleteSearch/renderItems/common';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';

export const ToolSearchItem = forwardRef<
  HTMLDivElement,
  ComboboxItem & { hit: SearchIndexDataMap['tools'][number] }
>(({ value, hit, ...props }, ref) => {
  if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

  const { name, icon } = hit;

  return (
    <Group ref={ref} {...props} key={hit.id} gap="md" wrap="nowrap">
      {icon ? (
        <Image
          src={getEdgeUrl(icon, { width: 96 })}
          alt={name ?? ''}
          width={32}
          height={32}
          radius="xl"
        />
      ) : (
        <ThemeIcon variant="light" size={32} radius="xl">
          <IconUser size={18} stroke={2.5} />
        </ThemeIcon>
      )}
      <Text size="md" lineClamp={1}>
        {name}
      </Text>
    </Group>
  );
});

ToolSearchItem.displayName = 'ToolSearchItem';
