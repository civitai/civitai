import { Drawer, Group, Menu, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import type { ReactElement, ReactNode } from 'react';
import { cloneElement, createContext, useContext, useMemo } from 'react';

import { NextLink as Link } from '~/components/NextLink/NextLink';

/**
 * F3 — THE ONE ADAPTIVE FLOATING SURFACE THE APP-BLOCK CHROME USES.
 *
 * The chrome opens three things off one 31px bar: the platform-nav menu behind the
 * app icon, the ⋮ overflow menu, and the app-name card. On a desktop-width bar those
 * are a `Menu`, a `Menu` and a `Popover`; below the `sm` breakpoint all three become
 * the same thing — a `Drawer position="bottom"`, the site's bottom-sheet idiom.
 *
 * 🔴 WHY ONE PRIMITIVE RATHER THAN THREE `mobile ? <Drawer> : <Menu>` BRANCHES. The
 * repo already has ~20 hand-rolled bottom sheets and no shared component, and the two
 * best of them (`AdaptiveFiltersDropdown`, `SelectMenuV2`) disagree with each other
 * about `zIndex`, about which slot gets the padding, and about whether the sheet sizes
 * to its content. Writing a third, fourth and fifth copy inside one 35-line bar is how
 * the desktop/mobile predicate ends up spelled three ways and wrong in two of them —
 * the exact shape `useIframeAwareMenu` (F0) was extracted to stop, one layer up. Here
 * the branch is written ONCE and every chrome surface inherits it.
 *
 * 🔴 IT OWNS THE ITEMS TOO, AND THAT IS THE LOAD-BEARING HALF. A `Menu.Item` calls
 * `useMenuContext()`, which THROWS outside a `<Menu>` — so the platform-nav items
 * cannot simply be re-parented into a Drawer, and neither can F4's review entry point,
 * which is a `Menu.Item`-rendering COMPONENT with its own hooks and gates that the
 * chrome does not get to restructure. `ChromeSurfaceItem` renders a `Menu.Item` in
 * menu mode and a full-width sheet row otherwise, so one call site serves both and
 * `ChromeReviewMenuItem` keeps working inside the sheet unchanged.
 *
 * 🔴 THE OPEN STATE IS STILL `useIframeAwareMenu`, INCLUDING FOR THE DRAWER — and the
 * reason is NOT that a Drawer needs it. It does not: a Drawer draws a scrim over the
 * whole viewport, so a click aimed at the app iframe lands on the scrim in the PARENT
 * document and Mantine's own `onClose` fires. The window-`blur` close is inert there.
 * It is shared anyway because this component is ONE component with a mode switch: the
 * `menu` and `popover` modes are the surfaces that genuinely need the blur close, and
 * giving the sheet its own `useState` would mean the desktop path's control state came
 * from a different place depending on a viewport measurement — a difference with no
 * behavioural justification and one more thing for a future control to get wrong. The
 * ledger in `__tests__/iframeAwareMenu.test.ts` pins it: every floating surface in this
 * file is controlled, and every chrome call site holds exactly one hook per surface.
 *
 * 🔴 THE BOTTOM SAFE-AREA INSET IS NOT PAID HERE, DELIBERATELY. `src/styles/globals.css`
 * pays it at the LIBRARY SEAM — `@layer mantine { .mantine-Drawer-content { padding-bottom:
 * var(--safe-area-inset-bottom) } }` — so every Drawer in the app is covered on the day
 * it is written rather than 41 call sites being edited one at a time. Paying it a second
 * time here would double it on a notched phone. What this component must do instead is
 * stay COVERED by that rule: it must not override the `content` slot's padding. The
 * repo-wide sweep in `src/components/Meta/__tests__/viewport-fit-cover.test.ts` fails if
 * it ever does, and `AppBlockChromeMobileShell.browser.test.tsx` measures the resolved
 * `padding-bottom` on the real rendered sheet against a non-zero injected inset.
 */

type ChromeSurfaceMode = 'menu' | 'popover' | 'sheet';

/**
 * The control shape `useIframeAwareMenu()` returns. Declared structurally rather than
 * imported as a `ReturnType<>` so a test can hand in a plain object.
 */
export interface ChromeSurfaceControl {
  opened: boolean;
  onChange: (opened: boolean) => void;
}

interface ChromeSurfaceContextValue {
  mode: ChromeSurfaceMode;
  /** Close the surface. A `Menu` closes itself on item click; a Drawer does not. */
  close: () => void;
}

/**
 * Defaults to `menu` so a `ChromeSurfaceItem` rendered outside any surface behaves
 * exactly as the `Menu.Item` it replaced. That is the conservative default: the
 * failure mode of guessing `menu` wrongly is a Mantine context error at the call
 * site, which is loud, whereas guessing `sheet` wrongly renders a plausible-looking
 * row inside a dropdown and nobody notices.
 */
const ChromeSurfaceContext = createContext<ChromeSurfaceContextValue>({
  mode: 'menu',
  close: () => undefined,
});

/** Exported for tests and for a future item that needs to branch on the rendering. */
export function useChromeSurfaceMode(): ChromeSurfaceMode {
  return useContext(ChromeSurfaceContext).mode;
}

export function ChromeSurface({
  compact,
  kind,
  control,
  target,
  title,
  width,
  position,
  dropdownTestId,
  children,
}: {
  /**
   * Render the mobile shell (a bottom sheet) rather than the desktop floating surface.
   * Resolved by the CALLER from `chromeGeometry`'s `compact`, which is measured off the
   * bar's own inline size — never off the viewport, and never off the page's `main`
   * container query. See `chromeGeometry.ts` for why that distinction is load-bearing
   * on a bar that renders both in a 320px model sidebar and as a 2560px page header.
   */
  compact: boolean;
  /** What this surface is on a DESKTOP-width bar. Ignored when `compact`. */
  kind: 'menu' | 'popover';
  /** Controlled open state — `useIframeAwareMenu()`. See the header. */
  control: ChromeSurfaceControl;
  /**
   * The trigger. A single element; it is cloned with an `onClick` in `popover` and
   * `sheet` modes and passed through untouched in `menu` mode.
   *
   * 🔴 THE CLONE IS REQUIRED, NOT BELT-AND-BRACES, AND ONLY IN THOSE TWO MODES.
   * `PopoverTarget` clones its child with
   * `...(!ctx.controlled ? { onClick: ctx.onToggle } : null)` (@mantine/core 7.17.8),
   * so a CONTROLLED popover target gets NO click handler from Mantine — the result is
   * a real button with every correct ARIA attribute that opens nothing, and neither a
   * type error nor a lint error can see it. `MenuTarget` has no such guard, so `menu`
   * mode keeps Mantine's own handler and stays byte-identical to what shipped.
   */
  target: ReactElement;
  /** Sheet header text. Host-authored and short — never the publisher's app name. */
  title: string;
  /** Desktop dropdown width (px). Ignored in sheet mode, which is full-bleed. */
  width: number;
  /** Desktop floating-surface placement. Ignored in sheet mode. */
  position: 'bottom-start' | 'bottom-end';
  /**
   * Testid for the surface's CONTENT box, so one query addresses the dropdown and the
   * sheet alike and a test does not have to know which one it is looking at.
   */
  dropdownTestId: string;
  children: ReactNode;
}) {
  const mode: ChromeSurfaceMode = compact ? 'sheet' : kind;
  const { onChange } = control;
  // `onChange` is referentially stable (`useIframeAwareMenu` memoizes it with an empty
  // dep list), so this value only changes when the mode does.
  const context = useMemo<ChromeSurfaceContextValue>(
    () => ({ mode, close: () => onChange(false) }),
    [mode, onChange]
  );

  if (mode === 'sheet') {
    return (
      <ChromeSurfaceContext.Provider value={context}>
        {cloneElement(target, {
          onClick: () => onChange(!control.opened),
          'aria-haspopup': 'dialog',
          'aria-expanded': control.opened,
        } as Partial<Record<string, unknown>>)}
        <Drawer
          opened={control.opened}
          onClose={() => onChange(false)}
          position="bottom"
          title={title}
          // Above the chrome bar and above the app iframe. 400 is what `SelectMenuV2`
          // uses for the same job; the chrome has no z-index of its own to clear.
          zIndex={400}
          closeButtonProps={{ 'aria-label': `Close ${title}` }}
          styles={{
            // Size to the content instead of Mantine's fixed `size="md"`, capped so a
            // long "Recently run" list scrolls rather than covering the whole app.
            // 🔴 NOT the `padding` of this slot — that is where the global
            // `--safe-area-inset-bottom` payment lands, and overriding it here would
            // un-pay the home-indicator strip for these two sheets alone.
            content: { height: 'auto', maxHeight: '75dvh' },
            body: { paddingTop: 4, paddingLeft: 8, paddingRight: 8 },
            header: { paddingTop: 8, paddingBottom: 8 },
          }}
        >
          <Stack gap={2} data-testid={dropdownTestId}>
            {children}
          </Stack>
        </Drawer>
      </ChromeSurfaceContext.Provider>
    );
  }

  if (mode === 'popover') {
    return (
      <ChromeSurfaceContext.Provider value={context}>
        <Popover
          width={width}
          position={position}
          shadow="md"
          withArrow
          opened={control.opened}
          onChange={onChange}
        >
          <Popover.Target>
            {cloneElement(target, {
              onClick: () => onChange(!control.opened),
            } as Partial<Record<string, unknown>>)}
          </Popover.Target>
          <Popover.Dropdown data-testid={dropdownTestId}>{children}</Popover.Dropdown>
        </Popover>
      </ChromeSurfaceContext.Provider>
    );
  }

  return (
    <ChromeSurfaceContext.Provider value={context}>
      <Menu
        position={position}
        shadow="md"
        width={width}
        opened={control.opened}
        onChange={onChange}
      >
        <Menu.Target>{target}</Menu.Target>
        <Menu.Dropdown data-testid={dropdownTestId}>{children}</Menu.Dropdown>
      </Menu>
    </ChromeSurfaceContext.Provider>
  );
}

/**
 * One row of a chrome surface — a `Menu.Item` in a dropdown, a full-width tappable row
 * in a bottom sheet.
 *
 * 🔴 THE SHEET ROW CLOSES ITS OWN SURFACE; THE MENU ITEM MUST NOT. Mantine's
 * `closeOnItemClick` already runs `closeDropdownImmediately` on a `Menu.Item`, which in
 * a CONTROLLED menu calls our `onChange(false)` — so adding a close here would be a
 * second, redundant call on the desktop path and a behaviour change on a surface this
 * change is not supposed to touch. A `Drawer` has no equivalent default, so the row
 * supplies it. Without that, tapping "Rate this app" in the sheet parks a bottom sheet
 * behind a focus-trapping modal — the visible half of the defect F0 fixed, arriving
 * through the other rendering.
 */
export function ChromeSurfaceItem({
  href,
  onClick,
  leftSection,
  children,
  'data-testid': dataTestId,
}: {
  /** A literal route. Renders a real anchor in both modes (keyboard / middle-click). */
  href?: string;
  onClick?: () => void;
  leftSection?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const { mode, close } = useContext(ChromeSurfaceContext);

  if (mode === 'menu') {
    return (
      <Menu.Item
        component={href ? Link : undefined}
        href={href}
        leftSection={leftSection}
        onClick={onClick}
        data-testid={dataTestId}
      >
        {children}
      </Menu.Item>
    );
  }

  const handleClick = () => {
    close();
    onClick?.();
  };
  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    // A comfortable touch row. The BAR's 31px resting height is a pinned CLS
    // contract (`CHROME_BAR_PX`) and is untouched by this; the SHEET is a
    // portaled overlay with no such constraint, so its rows can be finger-sized.
    minHeight: 44,
    padding: '8px 10px',
    borderRadius: 'var(--mantine-radius-sm)',
  } as const;
  const body = (
    <>
      {leftSection}
      <Text size="sm" lineClamp={1}>
        {children}
      </Text>
    </>
  );

  // 🔴 TWO BRANCHES RATHER THAN `component={href ? Link : 'button'}`. Mantine's
  // polymorphic `component` prop is typed against ONE component at a time, so the
  // ternary widens to a union it will not accept — and casting it away would take
  // the `href` prop's own checking with it. Two explicit branches keep both.
  if (href) {
    return (
      <UnstyledButton
        component={Link}
        href={href}
        onClick={handleClick}
        data-testid={dataTestId}
        style={rowStyle}
      >
        {body}
      </UnstyledButton>
    );
  }
  return (
    <UnstyledButton onClick={handleClick} data-testid={dataTestId} style={rowStyle}>
      {body}
    </UnstyledButton>
  );
}

/** A section heading — `Menu.Label` in a dropdown, a dimmed row label in a sheet. */
export function ChromeSurfaceLabel({ children }: { children: ReactNode }) {
  const { mode } = useContext(ChromeSurfaceContext);
  if (mode === 'menu') return <Menu.Label>{children}</Menu.Label>;
  return (
    <Text size="xs" c="dimmed" fw={500} px={10} pt={8} pb={2} tt="uppercase">
      {children}
    </Text>
  );
}

/**
 * A group wrapper for the sheet/menu that needs a testid of its own (the "Recently run"
 * section). Exists only so the chrome does not have to render a bare `<div>` whose
 * `display: block` breaks the sheet's row rhythm.
 */
export function ChromeSurfaceGroup({
  children,
  'data-testid': dataTestId,
}: {
  children: ReactNode;
  'data-testid'?: string;
}) {
  const { mode } = useContext(ChromeSurfaceContext);
  if (mode === 'menu') return <div data-testid={dataTestId}>{children}</div>;
  return (
    <Group gap={2} data-testid={dataTestId} style={{ flexDirection: 'column', width: '100%' }}>
      {children}
    </Group>
  );
}
