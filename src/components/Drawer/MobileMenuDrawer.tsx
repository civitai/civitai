import type { DrawerProps } from '@mantine/core';
import { Drawer } from '@mantine/core';

/**
 * The bottom sheet every menu-shaped thing opens into on touch: sort, filters, the
 * hub picker.
 *
 * Two things it fixes for its callers:
 *
 * - **Height on the CONTENT, not through `size`.** For a bottom drawer Mantine turns
 *   `size` into `height: var(--drawer-size)`, so every value there — `"auto"`
 *   included — gives a fixed-height panel. Set inline, because that variable is what
 *   has to be beaten.
 * - **90% of the viewport at most**, so the overlay is always reachable above the
 *   sheet: tapping it is how most people close one of these.
 */
export function MobileMenuDrawer({ children, styles, ...props }: DrawerProps) {
  return (
    <Drawer
      position="bottom"
      styles={{
        content: { height: 'auto', maxHeight: '90dvh' },
        body: { overflowY: 'auto', padding: '0 16px 16px' },
        // Left padding matches the body's, so the title sits on the same line as the
        // content under it; the right stays tight to keep the close button at the edge.
        header: { padding: '8px 8px 8px 16px' },
        close: { height: 32, width: 32 },
        ...styles,
      }}
      {...props}
    >
      {children}
    </Drawer>
  );
}
