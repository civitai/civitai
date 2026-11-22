import type { AccordionProps } from '@mantine/core';
import { Accordion, useComputedColorScheme } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * The model page's "Details" accordion look: padded control, label without its own padding,
 * a bordered, shadowed item and a panel with no padding so the table inside runs edge to edge.
 */
export function DetailsAccordion<Multiple extends boolean = false>(
  props: AccordionProps<Multiple>
) {
  const colorScheme = useComputedColorScheme('dark');
  return (
    <Accordion<Multiple>
      variant="separated"
      styles={(theme) => ({
        content: { padding: 0 },
        label: { padding: 0 },
        item: {
          overflow: 'hidden',
          borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
          boxShadow: theme.shadows.sm,
        },
        control: {
          padding: theme.spacing.sm,
          gap: theme.spacing.md,
        },
      })}
      {...props}
    />
  );
}

export function DetailsAccordionItem({
  value,
  title,
  children,
}: {
  value: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Accordion.Item value={value}>
      <Accordion.Control>{title}</Accordion.Control>
      <Accordion.Panel p={0}>{children}</Accordion.Panel>
    </Accordion.Item>
  );
}
