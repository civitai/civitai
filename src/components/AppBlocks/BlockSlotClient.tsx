import { Tabs } from '@mantine/core';
import { useMemo, useState } from 'react';
import { BlockErrorBoundary } from './BlockErrorBoundary';
import { BlockHost } from './BlockHost';
import { useHiddenBlocks } from './hiddenBlocks';
import { sortInstallsForSlot, tabLabelFor } from './sortInstallsForSlot';
import { useBlockSlot } from './useBlockSlot';
import type { ModelSlotContext } from './types';

interface BlockSlotClientProps {
  slotId: ModelSlotContext['slotId'];
  context: ModelSlotContext;
}

const TAB_LABEL_MAX_CHARS = 20;

function truncateLabel(label: string): string {
  if (label.length <= TAB_LABEL_MAX_CHARS) return label;
  return `${label.slice(0, TAB_LABEL_MAX_CHARS - 1)}…`;
}

/**
 * Client-only renderer used by BlockSlot. Querying the registry requires a
 * tRPC client, so this lives behind a `dynamic(..., { ssr: false })` in
 * BlockSlot.tsx to keep the server bundle clean.
 *
 * W8 multi-block tabs: when multiple installs target the same slot, render
 * them as Mantine Tabs ordered by manifest priority (desc) then name (asc).
 * Only the active tab's BlockHost is mounted at a time — inactive tabs do
 * NOT issue JWT tokens. This keeps cost + audit noise bounded; the tradeoff
 * is that switching tabs re-runs BLOCK_INIT each time (no warm-pool yet).
 */
export function BlockSlotClient({ slotId, context }: BlockSlotClientProps) {
  const { installs, isLoading, error, reservation } = useBlockSlot({
    slotId,
    modelId: context.modelId,
    modelType: context.modelType,
    modelNsfwLevel: context.modelNsfwLevel,
  });

  const sortedInstalls = useMemo(() => sortInstallsForSlot(installs, slotId), [installs, slotId]);
  // Viewer-local "Hide app block" (persisted to localStorage, via the host
  // trust-frame's ⋯ menu). Filter hidden installs out BEFORE any render/mount
  // so a hidden block never issues a token; the hook re-renders this slot the
  // instant a hide happens. See hiddenBlocks.ts.
  const hidden = useHiddenBlocks();
  const visibleInstalls = useMemo(
    () => sortedInstalls.filter((i) => !hidden.has(i.blockInstanceId)),
    [sortedInstalls, hidden]
  );
  const firstBlockInstanceId = visibleInstalls[0]?.blockInstanceId ?? null;
  const [activeTab, setActiveTab] = useState<string | null>(firstBlockInstanceId);

  // Keep activeTab in sync if the install list changes (e.g. a refetch drops
  // the currently-active install, or the viewer just hid it). Resync only when
  // the previously-active id is no longer present.
  const activeStillPresent = useMemo(
    () => visibleInstalls.some((i) => i.blockInstanceId === activeTab),
    [visibleInstalls, activeTab]
  );

  if (error) return null; // fail-soft — never surface a block error as page-level
  if (isLoading) {
    // CLS fix (Source A): the slot used to return null while the
    // listForModel query was in flight, so the slot was 0px and then popped
    // to full height once the frame mounted — shoving the sidebar content
    // below it down. With the model-page SSR prefetch this branch rarely
    // runs (data is already hydrated, isLoading=false), but for client-side
    // navigation / a cold refetch we reserve the right height UP-FRONT when
    // an install is expected.
    //
    // Zero-install no-regression: when the reservation is 0 (no install
    // known, or only inline installs) we still return null so a zero-install
    // model page reserves NOTHING — preserving the deliberate "no dead gap
    // row in the sidebar Stack" behavior the original `return null` existed
    // for.
    if (reservation.reservedHeight > 0) {
      return (
        <div
          data-app-block-reserve
          data-block-slot={slotId}
          style={{ minHeight: reservation.reservedHeight }}
        />
      );
    }
    return null;
  }
  if (visibleInstalls.length === 0) return null;

  // 1-install path: render the BlockHost directly with no tab chrome so the
  // existing visual layout is preserved.
  if (visibleInstalls.length === 1) {
    const install = visibleInstalls[0];
    return (
      <div
        data-block-slot={slotId}
        data-block-count={1}
        data-active-block-id={install.blockInstanceId}
      >
        <BlockErrorBoundary blockName={install.manifest.name}>
          <BlockHost blockInstall={install} slotContext={context} />
        </BlockErrorBoundary>
      </div>
    );
  }

  const effectiveActive = activeStillPresent ? activeTab : firstBlockInstanceId;
  const activeInstall = visibleInstalls.find((i) => i.blockInstanceId === effectiveActive) ?? null;

  return (
    <div
      data-block-slot={slotId}
      data-block-count={visibleInstalls.length}
      data-active-block-id={effectiveActive ?? undefined}
    >
      <Tabs value={effectiveActive} onChange={(v) => setActiveTab(v)} variant="default">
        <Tabs.List>
          {visibleInstalls.map((install) => {
            const fullLabel = tabLabelFor(install);
            return (
              <Tabs.Tab
                key={install.blockInstanceId}
                value={install.blockInstanceId}
                title={fullLabel}
              >
                {truncateLabel(fullLabel)}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        {/* Only mount the active tab's BlockHost. We deliberately avoid
            <Tabs.Panel> per-install because Mantine renders inactive panels
            in the DOM (display:none) — that still triggers React mounts +
            our JWT issuance. The single mount below is keyed on the active
            blockInstanceId so a tab switch unmounts the previous host and
            mounts a fresh one for the new install. */}
        {activeInstall && (
          <BlockErrorBoundary
            key={activeInstall.blockInstanceId}
            blockName={activeInstall.manifest.name}
          >
            <BlockHost blockInstall={activeInstall} slotContext={context} />
          </BlockErrorBoundary>
        )}
      </Tabs>
    </div>
  );
}
