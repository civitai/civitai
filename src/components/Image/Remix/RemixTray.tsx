import { ActionIcon, getDefaultZIndex, Loader, Paper, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconLoader2, IconPhoto, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import type { RemixRun } from '~/components/Image/Remix/useRemixRuns';
import { useRemixRuns } from '~/components/Image/Remix/useRemixRuns';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { openRemixAppModal } from '~/components/Dialog/triggers/remix-app';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

/** Above Mantine's toasts (`overlay`), which otherwise sit over the tray's corner on a phone. */
const TRAY_Z = getDefaultZIndex('overlay') + 1;
/** Under a modal (dialogs start at 300), so the one a row opens is not covered by the tray. */
const UNDER_DIALOG_Z = 100;

const statusLabel: Record<RemixRun['status'], string> = {
  running: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
};

export function RemixTrayView({
  runs,
  inProgress,
  ready,
  onOpen,
  onDismiss,
}: {
  runs: RemixRun[];
  inProgress: number;
  ready: number;
  onOpen?: (run: RemixRun) => void;
  onDismiss: (run: RemixRun) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // A routed dialog (the image page as a modal) is a page the tray floats over, as on any other.
  const underDialog = useDialogStore((state) =>
    state.dialogs.some((d) => d.type !== 'routed-dialog')
  );
  if (!inProgress && !ready) return null;

  return (
    // Above the footer and the Assistant button that floats over its right end.
    <div
      className="fixed bottom-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid)+4.5rem)] right-[calc(1rem+var(--safe-area-inset-right))] flex flex-col items-end gap-2"
      style={{ zIndex: underDialog ? UNDER_DIALOG_Z : TRAY_Z }}
      data-testid="remix-tray"
    >
      {expanded && (
        <Paper
          withBorder
          shadow="md"
          radius="md"
          className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden"
        >
          <ul aria-label="Remix runs" className="max-h-80 overflow-y-auto">
            {runs.map((run) => (
              <li
                key={run.runId}
                className="flex items-center gap-2 border-b border-gray-3 p-2 last:border-b-0 dark:border-dark-4"
              >
                <UnstyledButton
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onClick={() => onOpen?.(run)}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-2 dark:bg-dark-5">
                    {run.thumbnailUrl ? (
                      <EdgeMedia2
                        src={run.thumbnailUrl}
                        type="image"
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : run.status === 'running' ? (
                      <Loader size="xs" />
                    ) : (
                      <IconPhoto size={18} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <Text size="sm" fw={600} truncate>
                      {run.appName}
                    </Text>
                    <Text size="xs" c={run.status === 'failed' ? 'red' : 'dimmed'}>
                      {statusLabel[run.status]}
                    </Text>
                  </div>
                </UnstyledButton>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Dismiss ${run.appName}`}
                  onClick={() => onDismiss(run)}
                >
                  <IconX size={16} />
                </ActionIcon>
              </li>
            ))}
          </ul>
        </Paper>
      )}
      <UnstyledButton
        aria-label={`Remix runs: ${inProgress} in progress, ${ready} ready`}
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex items-center gap-2 rounded-full bg-dark-6 px-3 py-2 text-sm font-semibold text-white shadow-lg"
      >
        <span className="flex items-center gap-1" data-testid="remix-tray-in-progress">
          <IconLoader2 size={16} className={inProgress ? 'animate-spin' : undefined} />
          {inProgress}
        </span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1" data-testid="remix-tray-ready">
          <IconCheck size={16} />
          {ready}
        </span>
      </UnstyledButton>
    </div>
  );
}

/** The floating tray of the viewer's open remix runs. */
export function RemixTray({ onOpen }: { onOpen?: (run: RemixRun) => void }) {
  const features = useOptionalFeatureFlags();
  const enabled = !!features?.remixApps;
  const { runs, inProgress, ready, dismiss } = useRemixRuns({ enabled });
  if (!enabled) return null;
  return (
    <RemixTrayView
      runs={runs}
      inProgress={inProgress}
      ready={ready}
      onOpen={onOpen}
      onDismiss={dismiss}
    />
  );
}

/** The tray on every page, each row reopening its run's modal. */
export function RemixTrayMount() {
  return (
    <RemixTray
      onOpen={(run) =>
        openRemixAppModal({
          app: { slug: run.slug, name: run.appName, runtime: run.runtime },
          imageId: run.imageId,
          run: { runId: run.runId, workflowId: run.workflowId },
        })
      }
    />
  );
}
