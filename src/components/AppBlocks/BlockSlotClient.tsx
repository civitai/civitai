import { Tabs } from '@mantine/core';
import { useMemo, useState } from 'react';
import { BlockErrorBoundary } from './BlockErrorBoundary';
import { BlockHost } from './BlockHost';
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
  const { installs, isLoading, error } = useBlockSlot({
    slotId,
    modelId: context.modelId,
    modelType: context.modelType,
    modelNsfwLevel: context.modelNsfwLevel,
  });

  const sortedInstalls = useMemo(() => sortInstallsForSlot(installs, slotId), [installs, slotId]);
  const firstBlockInstanceId = sortedInstalls[0]?.blockInstanceId ?? null;
  const [activeTab, setActiveTab] = useState<string | null>(firstBlockInstanceId);

  // Keep activeTab in sync if the install list changes (e.g. a refetch drops
  // the currently-active install). Resync only when the previously-active id
  // is no longer present.
  const activeStillPresent = useMemo(
    () => sortedInstalls.some((i) => i.blockInstanceId === activeTab),
    [sortedInstalls, activeTab]
  );

  if (error) return null; // fail-soft — never surface a block error as page-level
  if (isLoading) return null;
  if (sortedInstalls.length === 0) return null;

  // 1-install path: render the BlockHost directly with no tab chrome so the
  // existing visual layout is preserved.
  if (sortedInstalls.length === 1) {
    const install = sortedInstalls[0];
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
  const activeInstall = sortedInstalls.find((i) => i.blockInstanceId === effectiveActive) ?? null;

  return (
    <div
      data-block-slot={slotId}
      data-block-count={sortedInstalls.length}
      data-active-block-id={effectiveActive ?? undefined}
    >
      <Tabs value={effectiveActive} onChange={(v) => setActiveTab(v)} variant="default">
        <Tabs.List>
          {sortedInstalls.map((install) => {
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
