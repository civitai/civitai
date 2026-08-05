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
  // The captured fields, and WHICH block instance they describe.
  const frozenFields = useRef<BlockInitFragmentFields>(fields);
  const frozenFor = useRef<string>(fields.blockInstanceId);

  // 🔴 SCOPED TO THE BLOCK INSTANCE, NOT TO THE MOUNT.
  //
  // A per-MOUNT ref is wrong here, and `PageBlockHost` says so itself: it is
  // rendered with no `key`, and `_app.tsx` renders `<Component>` with no key
  // either, so a SOFT navigation between two apps (appA → appB via the
  // "Recently run" menu) REUSES the component instance — same mount, different
  // `blockInstanceId`. Every other per-mount latch in that file was
  // deliberately re-scoped to the instance for exactly this reason (see its
  // `launchInstanceRef` / `shouldResetLaunchMarks` pair); this one was not, and
  // the measured result was app B's document receiving app A's id and app A's
  // mount-time theme while `BLOCK_INIT` delivered B's — a block seeing two
  // contradicting identities.
  //
  // Re-capturing on an instance change keeps BOTH properties: within one block
  // instance the fields are frozen (so a theme toggle cannot move the `src`
  // attribute of a live third-party iframe), and across a soft-nav the new app
  // gets its OWN id and the CURRENT theme.
  //
  // Assigning a ref during render is safe here because it is idempotent and
  // derived purely from props — the same "reset derived state when a prop
  // changes" pattern the sibling latch uses.
  if (frozenFor.current !== fields.blockInstanceId) {
    frozenFor.current = fields.blockInstanceId;
    frozenFields.current = fields;
  }

  return useMemo(
    () => (enabled ? buildBlockIframeSrc(baseSrc, frozenFields.current) : baseSrc),
    // `blockInstanceId` IS a dependency: on a soft-nav the capture above
    // changes, and the memo must recompute to publish the new instance's
    // fragment. `theme` and `renderMode` are deliberately absent — that
    // absence is the freeze.
    [baseSrc, enabled, fields.blockInstanceId]
  );
}
