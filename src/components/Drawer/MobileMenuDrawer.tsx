import type { DrawerProps } from '@mantine/core';
import { ActionIcon, Drawer, Text } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { mobileMenuSheetZIndex } from '~/shared/constants/app-layout.constants';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import classes from './MobileMenuDrawer.module.scss';

type DrillPanel = {
  title: ReactNode;
  onBack: () => void;
  /** Holds the sheet at full height, so a list being searched doesn't shrink under the finger. */
  tall?: boolean;
};

type SheetDrill = {
  /** Where a drilled-in panel renders its content (through a portal). */
  panelEl: HTMLElement | null;
  open: (panel: DrillPanel) => void;
  close: () => void;
};

const SheetDrillContext = createContext<SheetDrill | null>(null);

/**
 * Inside a `MobileMenuDrawer`, a way to replace the sheet's content with a panel of its own (a
 * select's options), with a back arrow in the header, instead of opening a sheet over it.
 */
export function useSheetDrill() {
  return useContext(SheetDrillContext);
}

/**
 * The bottom sheet every menu-shaped thing opens into on touch: sort, filters, the
 * hub picker.
 *
 * Three things it fixes for its callers:
 *
 * - **Height on the CONTENT, not through `size`.** For a bottom drawer Mantine turns
 *   `size` into `height: var(--drawer-size)`, so every value there — `"auto"`
 *   included — gives a fixed-height panel. Set inline, because that variable is what
 *   has to be beaten.
 * - **Short of the full viewport height**, so the overlay is always reachable above the
 *   sheet: tapping it is how most people close one of these.
 * - **A z-index that clears the surfaces a menu gets opened from** — see
 *   `mobileMenuSheetZIndex`. Mantine's default of 200 puts the sheet behind the
 *   fullscreen generation panel and behind routed dialogs, where the tap registers
 *   and nothing appears.
 *
 * Over the mobile generator, Back closes it before it closes the generator, and closes a
 * drilled-in panel (`useSheetDrill`) before the sheet.
 */
export function MobileMenuDrawer({ children, styles, title, ...props }: DrawerProps) {
  const layered = useMobileGeneratorStore((state) => state.showing);
  useHistoryLayer(props.opened, props.onClose, layered);

  const [panel, setPanel] = useState<DrillPanel | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  // Drilled in since the sheet opened: its own content slides in again on the way back, but not
  // when the sheet first opens.
  const [drilled, setDrilled] = useState(false);
  useEffect(() => {
    if (!props.opened) setDrilled(false);
  }, [props.opened]);
  useHistoryLayer(!!panel, () => panel?.onBack(), layered);
  const drill = useMemo<SheetDrill>(
    () => ({
      panelEl,
      open: (next) => {
        setPanel(next);
        setDrilled(true);
      },
      close: () => setPanel(null),
    }),
    [panelEl]
  );

  const stylesObject = typeof styles === 'object' ? styles : undefined;
  return (
    <Drawer
      position="bottom"
      zIndex={mobileMenuSheetZIndex}
      styles={{
        ...stylesObject,
        content: {
          height: panel?.tall ? '90dvh' : 'auto',
          maxHeight: '90dvh',
          ...stylesObject?.content,
        },
        body: { overflowY: 'auto', padding: '0 16px 16px', ...stylesObject?.body },
        // Left padding matches the body's, so the title sits on the same line as the
        // content under it; the right stays tight to keep the close button at the edge.
        header: { padding: '8px 8px 8px 16px', ...stylesObject?.header },
        close: { height: 32, width: 32, ...stylesObject?.close },
      }}
      title={
        panel ? (
          <div className="flex items-center gap-1">
            <ActionIcon
              variant="subtle"
              color="gray"
              className="-ml-2"
              aria-label="Back"
              onClick={panel.onBack}
            >
              <IconArrowLeft size={20} />
            </ActionIcon>
            {typeof panel.title === 'string' ? <Text fw={600}>{panel.title}</Text> : panel.title}
          </div>
        ) : (
          title
        )
      }
      {...props}
    >
      <SheetDrillContext.Provider value={drill}>
        <div
          className={drilled ? classes.root : undefined}
          style={{ display: panel ? 'none' : 'contents' }}
        >
          {children}
        </div>
        <div ref={setPanelEl} className={classes.panel} hidden={!panel} />
      </SheetDrillContext.Provider>
    </Drawer>
  );
}
