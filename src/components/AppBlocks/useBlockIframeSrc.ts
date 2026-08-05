import { useMemo, useRef } from 'react';

import { buildBlockIframeSrc, type BlockInitFragmentFields } from './blockIframeUrl';

/**
 * The `src` an App Blocks iframe host should render: the publisher's
 * `manifest.iframe.src`, plus the init-fragment fast path when — and only when
 * — this block is gated ON for it (see `blockInitFragmentGate.ts`).
 *
 * `enabled` is a REQUIRED parameter, not an optional one with a permissive
 * default. Every call site must state its answer, so adding a new host is a
 * type error rather than a silent opt-in.
 *
 * 🔴 THE FRAGMENT FIELDS ARE FROZEN AT MOUNT, ON PURPOSE.
 *
 * `theme` can change while a block is mounted (the viewer toggles dark mode).
 * If the fragment tracked it, the iframe's `src` ATTRIBUTE would change on a
 * theme toggle — a navigation of a third-party frame where today there is
 * none. At best that is a `hashchange` inside the block; at worst a reload that
 * discards its in-progress state. In exchange for nothing: the host does not
 * propagate live theme changes to blocks today either, because the SDK dedupes
 * `BLOCK_INIT` and no theme-change message exists. Freezing keeps the rendered
 * `src` exactly as stable as it is today.
 *
 * This invariant is the safety argument for the whole fast path, so it is
 * pinned directly by `BlockInitFragmentFreeze.browser.test.tsx` — mount, change
 * `theme`, assert the produced string is byte-identical. That test exists
 * because an audit found the freeze had NO coverage in either tier: swapping
 * the frozen ref for live `fields` (with full deps) survived both suites.
 *
 * `baseSrc` is deliberately NOT frozen: if the publisher's manifest src really
 * changes mid-mount, the iframe should re-navigate exactly as it does today.
 */
export function useBlockIframeSrc(
  baseSrc: string,
  fields: BlockInitFragmentFields,
  enabled: boolean
): string {
  // First-render capture. A ref (not state) because there is no update path —
  // the value is written once, at mount, and read forever after.
  const frozenFields = useRef<BlockInitFragmentFields>(fields);

  return useMemo(
    () => (enabled ? buildBlockIframeSrc(baseSrc, frozenFields.current) : baseSrc),
    // frozenFields.current is stable for the component's lifetime, so baseSrc
    // and the gate are the only real inputs. Listed explicitly for the linter.
    [baseSrc, enabled]
  );
}
