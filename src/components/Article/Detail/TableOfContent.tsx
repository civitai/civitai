import { Text, Stack, Collapse } from '@mantine/core';
import { useState } from 'react';

import { NestedHeading, useIntersectionObserver } from '~/hooks/useHeadingsData';

export function TableOfContent({ headings }: Props) {
  const [activeId, setActiveId] = useState('');
  useIntersectionObserver(setActiveId);

  return (
    <nav aria-label="Table of contents">
      {headings.map((heading, index) => (
        <Heading key={index} activeId={activeId} {...heading} />
      ))}
    </nav>
  );
}

type Props = { headings: NestedHeading[] };

function Heading({
  parentIndex = 1,
  activeId,
  ...heading
}: NestedHeading & { parentIndex?: number; activeId?: string }) {
  const isActive = activeId === heading.id || heading.items.some((item) => item.id === activeId);
  const isFirstLevel = parentIndex === 1;
  const labelSize = isFirstLevel ? 'md' : 'sm';

  return (
    <Stack spacing={0}>
      <Text
        component="a"
        lineClamp={1}
        href={`#${heading.id}`}
        size={labelSize}
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
        {heading.title}
      </Text>
      {!!heading.items.length ? (
        <Collapse in={isActive}>
          {heading.items.map((item, index) => (
            <Heading key={index} activeId={activeId} parentIndex={parentIndex + 1} {...item} />
          ))}
        </Collapse>
      ) : null}
    </Stack>
  );
}
