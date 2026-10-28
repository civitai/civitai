import type { MenuProps } from '@mantine/core';
import { Overlay, Portal } from '@mantine/core';
import { useState } from 'react';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import { mobileMenuSheetZIndex } from '~/shared/constants/app-layout.constants';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import classes from './menuSheet.module.scss';

/**
 * In the mobile generator, a Mantine Menu opens as a bottom sheet over a backdrop, and Back closes
 * it; elsewhere it is the menu as written. Its items stay `Menu.Item`s, so one menu serves both.
 * Spread `menuProps` last on the Menu, give the dropdown `dropdownClassName`, and render `backdrop`.
 */
export function useMenuSheet() {
  const sheet = useMobileGenerator();
  const [opened, setOpened] = useState(false);
  const layered = useMobileGeneratorStore((state) => state.showing);
  useHistoryLayer(!!sheet && opened, () => setOpened(false), layered);

  if (!sheet) return { sheet, menuProps: {}, dropdownClassName: undefined, backdrop: null };
  const menuProps: Partial<MenuProps> = {
    opened,
    onChange: setOpened,
    trigger: 'click',
    withArrow: false,
    zIndex: mobileMenuSheetZIndex,
    transitionProps: { transition: 'slide-up', duration: 150 },
  };
  return {
    sheet,
    menuProps,
    dropdownClassName: classes.sheet,
    backdrop: opened && (
      <Portal>
        <Overlay fixed zIndex={mobileMenuSheetZIndex - 1} backgroundOpacity={0.6} />
      </Portal>
    ),
  };
}
