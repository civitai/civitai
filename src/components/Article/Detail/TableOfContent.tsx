import { Text, Stack, Collapse, ScrollArea, Anchor } from '@mantine/core';
import { useState } from 'react';

import { NestedHeading, useIntersectionObserver } from '~/hooks/useHeadingsData';

export function TableOfContent({ headings }: Props) {
  const [activeId, setActiveId] = useState('');
  useIntersectionObserver(setActiveId);

  return (
    <nav aria-label="Table of contents">
      <ScrollArea style={{ height: 300 }}>
        {headings.map((heading, index) => (
          <Heading key={index} activeId={activeId} {...heading} />
        ))}
      </ScrollArea>
    </nav>
  );
}

type Props = { headings: NestedHeading[] };

function Heading({
  parentIndex = 1,
  activeId,
  ...heading
}: NestedHeading & { parentIndex?: number; activeId?: string }) {
  const isActive = !!activeId && activeId === heading.id; // || heading.items.some((item) => item.id === activeId);
  const isFirstLevel = parentIndex === 1;
  const labelSize = isFirstLevel ? 'md' : 'sm';

  return (
    <Stack spacing={0}>
      <Anchor
        href={`#${heading.id}`}
        variant="text"
        sx={(theme) => ({
          padding: theme.spacing.sm,
          paddingLeft: isFirstLevel ? theme.spacing.sm : `${parentIndex * theme.spacing.md}px`,
          backgroundColor: isActive ? theme.fn.rgba(theme.colors.blue[5], 0.2) : 'transparent',
          color: isActive ? theme.colors.blue[2] : undefined,
        })}
        onClick={(event) => {
          event.preventDefault();

          document.getElementById(heading.id)?.scrollIntoView({
            behavior: 'smooth',
          });
        }}
      >
        <Text size={labelSize} lineClamp={2} inherit>
          {heading.title}
        </Text>
      </Anchor>
      {!!heading.items.length ? (
        <Collapse in={true}>
          {heading.items.map((item, index) => (
            <Heading key={index} activeId={activeId} parentIndex={parentIndex + 1} {...item} />
          ))}
        </Collapse>
      ) : null}
    </Stack>
  );
}
