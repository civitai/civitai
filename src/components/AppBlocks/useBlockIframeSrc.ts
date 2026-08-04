import { useMemo, useRef } from 'react';

import { buildBlockIframeSrc, type BlockInitFragmentFields } from './blockIframeUrl';

/**
 * The `src` an App Blocks iframe host should render: the publisher's
 * `manifest.iframe.src` plus the init-fragment fast path (see
 * `blockIframeUrl.ts` for the format, the no-stomp rule, and why the token is
 * NOT in there).
 *
 * 🔴 THE FRAGMENT FIELDS ARE FROZEN AT MOUNT, ON PURPOSE.
 *
 * `theme` can change while a block is mounted (the viewer toggles dark mode).
 * If the fragment tracked it, the iframe's `src` ATTRIBUTE would change on a
 * theme toggle — a navigation of a third-party frame where today there is
 * none. That is a behaviour change with real blast radius (at best a
 * `hashchange` in the block, at worst a reload that discards its in-progress
 * state) in exchange for nothing: the host does not propagate live theme
 * changes to blocks today either, because the SDK dedupes `BLOCK_INIT` and no
 * theme-change message exists. Freezing keeps the rendered `src` exactly as
 * stable as it is today.
 *
 * `baseSrc` is deliberately NOT frozen: if the publisher's manifest src really
 * changes mid-mount, the iframe should re-navigate exactly as it does today.
 */
export function useBlockIframeSrc(baseSrc: string, fields: BlockInitFragmentFields): string {
  // First-render capture. A ref (not state) because there is no update path —
  // the value is written once, at mount, and read forever after.
  const frozenFields = useRef<BlockInitFragmentFields>(fields);

  return useMemo(
    () => buildBlockIframeSrc(baseSrc, frozenFields.current),
    // frozenFields.current is stable for the component's lifetime, so baseSrc
    // is the only real input. Listed explicitly for the linter.
    [baseSrc]
  );
}
