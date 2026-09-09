/**
 * App Blocks slot-reservation math — the single source of truth for how much
 * vertical space a (modelId, slotId) App Block slot reserves up-front.
 *
 * Lives in a dependency-free, client-safe module so BOTH the server (model-
 * page SSR via BlockRegistry.getSlotReservation) AND the client slot
 * (BlockSlotClient's loading placeholder) derive the reserved height from the
 * exact same logic over the exact same install list — no drift, no extra
 * query, no server-only imports leaking into the client bundle.
 *
 * Why this matters (the CLS bug): the slot used to render 0px while the
 * `blocks.listForModel` tRPC query was in flight, then pop to full height
 * once it resolved, shoving the sidebar content below it down. Reserving the
 * right height up-front (and ONLY when an install actually exists) removes
 * the shift without re-introducing a dead gap on the common zero-install
 * model page.
 */

import type { BlockManifest } from './types';

/**
 * Height (px) of the `AppBlockChrome` provenance bar the host renders ABOVE
 * every block iframe (see IframeHost.tsx `AppBlockChrome`). Included in the
 * reservation so the server-seeded height matches what actually paints.
 *
 * Derivation (Mantine 7.17, default theme):
 *   - <Group py={4}> → numeric `py` resolves to rem(4px) top + bottom = 8px.
 *   - Tallest child is <ActionIcon size="sm">, `--ai-size-sm` = rem(26px) =
 *     26px (the 14px IconApps is shorter, so the ActionIcon governs the row).
 *   - 1px bottom border.
 *   => 26 + 8 + 1 = 35px.
 *
 * Update alongside any chrome-bar padding / ActionIcon size change in
 * IframeHost.tsx — the slot-reservation test pins this value to catch drift.
 *
 * 🔴 THE DERIVATION ABOVE IS WRONG BY 4px, AND THE VALUE IS DELIBERATELY LEFT AT
 * 35 ANYWAY. Measured 2026-08-31 by rendering the real chrome in Chromium at both
 * a 360px and a 2560px viewport (`AppBlockChromeResponsive.browser.test.tsx`): the
 * bar is **31px** tall, not 35, at every width. `--ai-size-sm` is not 26px — the
 * installed `@mantine/core` 7.17.8 ships
 * `--ai-size-sm: calc(1.375rem * var(--mantine-scale))` = 22px, and this repo
 * overrides neither the ActionIcon sizes nor `--mantine-scale`
 * (`src/providers/ThemeProvider.tsx` sets only `color` / `variant` defaults). So
 * the true sum is 22 + 8 (`py={4}` ×2) + 1 (border) = 31.
 *
 * Left as-is on purpose: 35 > 31 means the slot OVER-reserves, which is the safe
 * direction for a CLS reservation (a small dead gap, never a shift), and lowering
 * it changes the server-seeded height of every model-page slot — a behavioural
 * change on a different surface that wants its own before/after measurement, not a
 * drive-by edit inside a width-only chrome pass. The browser test asserts the
 * measured 31 and asserts `CHROME_BAR_PX >= ` it, so the gap stays visible and
 * cannot silently invert into an UNDER-reservation.
 */
export const CHROME_BAR_PX = 35;

/** Fallback iframe minHeight when a manifest omits / malforms it. Mirrors the
 * `?? 200` default used in BlockRegistry.listForModel's manifest projection
 * and in IframeHost. */
export const DEFAULT_IFRAME_MIN_HEIGHT = 200;

export interface SlotReservation {
  hasInstall: boolean;
  reservedHeight: number;
}

/** Minimal install shape the reservation needs — a subset of BlockInstall /
 * BlockInstallRecord so this module doesn't depend on either the client or
 * server record type. */
export interface ReservableInstall {
  manifest: Pick<BlockManifest, 'iframe'>;
  renderMode: 'iframe' | 'inline';
}

/**
 * Pure reservation derivation over an already-resolved install list (the
 * array `blocks.listForModel` returns).
 *
 *  - empty list           → { hasInstall: false, reservedHeight: 0 } so a
 *    zero-install page reserves NOTHING (no dead gap row).
 *  - one/more iframe blocks → reservedHeight = max(minHeight) + CHROME_BAR_PX
 *    (reserve for the tallest declared minHeight so none under-reserves).
 *  - only inline blocks   → hasInstall true but reservedHeight 0 (inline
 *    content lays out in-flow and sizes itself; no iframe reserve needed).
 */
export function computeSlotReservation(installs: ReservableInstall[]): SlotReservation {
  if (installs.length === 0) return { hasInstall: false, reservedHeight: 0 };
  let maxMinHeight = 0;
  for (const install of installs) {
    if (install.renderMode !== 'iframe') continue;
    const min = install.manifest.iframe?.minHeight;
    const h = typeof min === 'number' && min > 0 ? min : DEFAULT_IFRAME_MIN_HEIGHT;
    if (h > maxMinHeight) maxMinHeight = h;
  }
  const reservedHeight = maxMinHeight > 0 ? maxMinHeight + CHROME_BAR_PX : 0;
  return { hasInstall: true, reservedHeight };
}
