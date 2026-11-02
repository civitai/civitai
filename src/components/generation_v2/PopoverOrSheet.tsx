import type { PopoverDropdownProps, PopoverProps } from '@mantine/core';
import { Modal, Popover, Text } from '@mantine/core';
import type { ReactElement, ReactNode } from 'react';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { useGeneratorLayout } from '~/hooks/useMobileGenerator';
import { mobileMenuSheetZIndex } from '~/shared/constants/app-layout.constants';

export type PickerSurface = 'popover' | 'sheet' | 'fullscreen';

/**
 * Where a picker opens: a bottom sheet in the mobile generator, a popover on desktop, and on a
 * narrow screen in the legacy generator whatever that picker used before (`narrow`).
 */
export function usePickerSurface(narrow: 'sheet' | 'fullscreen' = 'sheet'): PickerSurface {
  const layout = useGeneratorLayout();
  if (layout === 'mobile') return 'sheet';
  if (layout === 'narrow') return narrow;
  return 'popover';
}

export interface PopoverOrSheetProps {
  opened: boolean;
  onClose: () => void;
  /** The control that opens it: the popover's anchor, rendered in place otherwise. */
  target: ReactElement;
  /** Heading of the sheet or full-screen modal; a popover has none. */
  title: ReactNode;
  /** Content, or a function of the surface for content that differs (bigger rows in a sheet). */
  children: ReactNode | ((surface: PickerSurface) => ReactNode);
  /** The legacy generator's surface on a narrow screen. */
  narrow?: 'sheet' | 'fullscreen';
  /** Holds the sheet at full height, so a list being searched doesn't shrink under the finger. */
  tall?: boolean;
  popoverProps?: Omit<PopoverProps, 'opened' | 'onChange' | 'children'>;
  dropdownProps?: PopoverDropdownProps;
}

export function PopoverOrSheet({
  opened,
  onClose,
  target,
  title,
  children,
  narrow,
  tall,
  popoverProps,
  dropdownProps,
}: PopoverOrSheetProps) {
  const surface = usePickerSurface(narrow);
  const content = typeof children === 'function' ? children(surface) : children;

  if (surface === 'popover') {
    return (
      <Popover
        opened={opened}
        // Opening is the target's job; the popover only reports dismissal (outside click, Escape).
        onChange={(isOpen) => !isOpen && onClose()}
        shadow="md"
        withinPortal
        {...popoverProps}
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown {...dropdownProps}>{content}</Popover.Dropdown>
      </Popover>
    );
  }

  const heading = typeof title === 'string' ? <Text fw={600}>{title}</Text> : title;
  return (
    <>
      {target}
      {surface === 'fullscreen' ? (
        <Modal
          opened={opened}
          onClose={onClose}
          title={title}
          fullScreen
          zIndex={mobileMenuSheetZIndex}
          styles={{ header: { borderBottom: '1px solid var(--mantine-color-default-border)' } }}
        >
          {content}
        </Modal>
      ) : (
        <MobileMenuDrawer
          opened={opened}
          onClose={onClose}
          title={heading}
          styles={tall ? { content: { height: '90dvh' } } : undefined}
        >
          {content}
        </MobileMenuDrawer>
      )}
    </>
  );
}
