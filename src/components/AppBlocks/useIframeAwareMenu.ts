import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Controlled-open state for a Mantine `<Menu>` rendered in the app-block host
 * chrome, which closes itself when focus leaves the parent document.
 *
 * 🔴 WHY THIS EXISTS AT ALL — Mantine's outside-click close is BLIND to the app.
 * The chrome sits directly above a CROSS-ORIGIN iframe that fills the rest of the
 * surface. A click landing inside that iframe is dispatched in the FRAME's
 * document, so the parent document never sees the `mousedown` and Mantine's
 * `closeOnClickOutside` can't tell the click was "outside" the dropdown. The menu
 * stays open, floating over the app the user just clicked into. Clicking into the
 * app IS the single most likely next action on this surface, so this is the
 * common path, not an edge case.
 *
 * The signal that DOES fire is the window `blur` event — focus moving into a
 * cross-origin frame blurs the parent window. So while the menu is open we listen
 * for `blur` and close on it. Everything else keeps Mantine's untouched defaults:
 * same-document outside-clicks still close via `closeOnClickOutside`, item clicks
 * via `closeOnItemClick`, Escape via `closeOnEscape`. The listener is only
 * attached while the menu is open, so a closed menu costs nothing.
 *
 * 🔴 WHY IT IS A HOOK RATHER THAN A SECOND COPY OF THE EFFECT. The chrome renders
 * TWO menus — the platform-nav ("Civitai Apps") menu behind the app icon, and the
 * ⋮ overflow menu. The behaviour above was originally written inline for the
 * platform-nav menu only, and the ⋮ menu — added in the same component, reading
 * the same iframe — silently did not get it: it was a bare uncontrolled `<Menu>`,
 * so clicking into the app left it stuck open. One rule open-coded at one site is
 * how the second site is born wrong. A new control added to this chrome now has a
 * single obvious thing to call, and the ledger test in
 * `__tests__/iframeAwareMenu.test.ts` fails if a `<Menu>` appears in the chrome
 * without it.
 *
 * @param onOpen optional side effect to run on the transition to OPEN (the
 *   platform-nav menu re-reads its localStorage recents list here so an in-SPA
 *   navigation shows the current list rather than the list as of first mount).
 *   Read through a ref, so the returned `onChange` is referentially stable and
 *   the caller does not have to memoize the callback.
 */
export function useIframeAwareMenu(onOpen?: () => void): {
  opened: boolean;
  onChange: (opened: boolean) => void;
} {
  const [opened, setOpened] = useState(false);

  // Keep the latest callback without making `onChange` depend on it. A caller
  // passing an inline arrow would otherwise get a new `onChange` every render.
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    // Only while open: a closed menu has nothing to close, and this keeps N
    // menus from each holding a window listener for the whole page lifetime.
    if (!opened) return;
    const onBlur = () => setOpened(false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [opened]);

  const onChange = useCallback((next: boolean) => {
    setOpened(next);
    if (next) onOpenRef.current?.();
  }, []);

  return { opened, onChange };
}
