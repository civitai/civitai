import type { ButtonProps } from '@mantine/core';
import {
  Popover,
  Indicator,
  Button,
  Stack,
  Drawer,
  ScrollArea,
  Group,
  useComputedColorScheme,
} from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';
import classes from './AdaptiveFiltersDropdown.module.scss';
import clsx from 'clsx';

export function AdaptiveFiltersDropdown({
  children,
  count,
  className,
  dropdownProps,
  opened: controlledOpened,
  onOpenedChange,
  footer,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const [uncontrolledOpened, setUncontrolledOpened] = useState(false);
  // Controlled when the caller passes `opened` (a staged-filters dropdown closes itself on Apply);
  // otherwise it manages its own state, as every other caller does.
  const controlled = controlledOpened !== undefined;
  const opened = controlled ? controlledOpened : uncontrolledOpened;
  const setOpened = (next: boolean | ((o: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(opened) : next;
    if (!controlled) setUncontrolledOpened(value);
    onOpenedChange?.(value);
  };
  const colorScheme = useComputedColorScheme('dark');

  const target = (
    <Indicator
      offset={4}
      label={isClient && count ? count : undefined}
      size={16}
      zIndex={10}
      disabled={!count}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        rightSection={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
        {...buttonProps}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group gap={4} wrap="nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = <Stack gap="lg">{children}</Stack>;

  // With a `footer` the panel owns its own padding (`children` brings it) and the footer sits
  // outside the padded, scrolling part so it can run edge to edge, like the other feeds' panels.
  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          classNames={{ root: dropdownProps?.className }}
          styles={{
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              ...(footer ? { display: 'flex', flexDirection: 'column' } : { overflowY: 'auto' }),
            },
            body: footer
              ? {
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  flex: 1,
                  minHeight: 0,
                }
              : { padding: 16, paddingTop: 0, overflowY: 'auto' },
            // Mantine keeps a 60px header even when it holds only the close button.
            header: footer ? { padding: '4px 8px', minHeight: 40 } : { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {footer ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
              {footer}
            </>
          ) : (
            dropdown
          )}
        </Drawer>
      </>
    );

  return (
    <Popover
      opened={controlled ? opened : undefined}
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
      classNames={{ dropdown: '!w-full' }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={footer ? 0 : undefined}>
        <ScrollArea.Autosize
          classNames={{ root: dropdownProps?.className }}
          type="hover"
          mah={'calc(90vh - var(--header-height) - 56px)'}
        >
          {footer ? children : dropdown}
        </ScrollArea.Autosize>
        {footer}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  children: React.ReactElement;
  count?: number;
  dropdownProps?: { className?: string };
  /** Controls the open state from outside; omit it and the dropdown manages its own. */
  opened?: boolean;
  onOpenedChange?: (opened: boolean) => void;
  /** A band under the scrolling panel that runs edge to edge (e.g. `StagedFiltersFooter`). `children` then brings its own padding. */
  footer?: React.ReactNode;
};
