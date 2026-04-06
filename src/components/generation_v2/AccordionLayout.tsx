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
import { useEffect, useRef, useState, type ReactNode } from 'react';

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

  const contentRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(true);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const checkContent = () => setHasContent(el.childElementCount > 0);
    checkContent();

    const observer = new MutationObserver(checkContent);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, []);

  return (
    <Card withBorder padding={0} style={hasContent ? undefined : { display: 'none' }}>
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
          <div ref={contentRef} className="accordion-content flex flex-col gap-3">
            {children}
          </div>
        </Card.Section>
      </Collapse>
    </Card>
  );
}
