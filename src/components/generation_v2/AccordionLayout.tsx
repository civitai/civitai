/**
 * AccordionLayout
 *
 * A collapsible accordion card layout for grouping form inputs.
 * Supports persisting open/closed state to localStorage.
 */

import { ActionIcon, Card, Collapse, Group, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';

export interface AccordionLayoutProps {
  children: ReactNode;
  label: string;
  storeKey?: string;
  defaultOpen?: boolean;
}

export function AccordionLayout({
  children,
  label,
  storeKey,
  defaultOpen = true,
}: AccordionLayoutProps) {
  const [storedOpened, setStoredOpened] = useLocalStorage<boolean>({
    key: storeKey ?? '__unused__',
    defaultValue: defaultOpen,
  });
  const [localOpened, setLocalOpened] = useState(defaultOpen);

  const opened = storeKey ? storedOpened : localOpened;
  const toggle = () => {
    if (storeKey) {
      setStoredOpened((prev) => !prev);
    } else {
      setLocalOpened((prev) => !prev);
    }
  };

  // Hide accordion when content has no visible children using :has() with child selector
  // Shows only when .accordion-content has at least one child element
  return (
    <Card withBorder padding={0} className="hidden has-[.accordion-content>*]:block">
      <Card.Section
        withBorder={opened}
        inheritPadding
        py="xs"
        px="sm"
        onClick={toggle}
        className="cursor-pointer select-none"
      >
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600}>{label}</Text>
          <ActionIcon
            component="div"
            variant="subtle"
            size="sm"
            className={clsx('transition-transform', { 'rotate-180': opened })}
          >
            <IconChevronDown size={16} />
          </ActionIcon>
        </Group>
      </Card.Section>

      <Collapse in={opened}>
        <Card.Section inheritPadding py="sm" px="sm">
          <div className="accordion-content flex flex-col gap-3">{children}</div>
        </Card.Section>
      </Collapse>
    </Card>
  );
}
