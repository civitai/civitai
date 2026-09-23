import { useCallback, useEffect, useRef, useState } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { resourceLoadSignalSchema } from '~/server/schema/resource-load.schema';
import { parseAIRSafe } from '~/shared/utils/air';
import { resourceLoadDrainVerdict, useResourceLoadStore } from '~/store/resource-load.store';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type ResourceLoadProgress = {
  modelVersionId: number;
  /** Downloads ahead of this one. Zero means it is transferring now. */
  queuePosition: number;
  /** 0..1, or null while the download is still queued. */
  progress: number | null;
  etaSeconds: number | null;
  workflowId: string | null;
  receivedAt: number;
};

/**
 * One `resource-load:update` payload → progress for the version its AIR names, or null if it says
 * nothing about a download.
 */
export function toResourceLoadProgress(raw: unknown): ResourceLoadProgress | null {
  const parsed = resourceLoadSignalSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.preparation) return null;

  const { resource, queuePosition, progress, etaSeconds } = parsed.data.preparation;
  const air = parseAIRSafe(resource);
  if (!air?.version) return null;

  return {
    modelVersionId: air.version,
    queuePosition,
    progress: progress ?? null,
    etaSeconds: etaSeconds ?? null,
    workflowId: parsed.data.workflowId ?? null,
    receivedAt: Date.now(),
  };
}

/**
 * Live download progress for this user's own loads, keyed by model version id.
 *
 * 🔴 The version id comes from the payload's AIR. Every load this user has in flight arrives on the
 * same per-user channel, so a card that assumed "an update arrived, therefore it is mine" would show
 * one model's progress on another as soon as two loads run at once.
 *
 * Payloads that do not parse, or that carry no `preparation`, are dropped: the orchestrator posts
 * an event for every step transition and only a `preparing` one describes a download.
 */
export function useResourceLoadProgress() {
  const [progress, setProgress] = useState<Record<number, ResourceLoadProgress>>({});

  useSignalConnection(
    SignalMessages.ResourceLoadUpdate,
    useCallback((raw: unknown) => {
      const update = toResourceLoadProgress(raw);
      if (!update) return;
      setProgress((current) => ({ ...current, [update.modelVersionId]: update }));
    }, [])
  );

  return progress;
}

/**
 * Drain the tracked-loads queue once per page load: tell the user what finished, drop what can no
 * longer finish, and keep what is still in flight.
 *
 * Runs once on mount rather than on an interval. While the page is open, live progress arrives on
 * the signals channel; this exists for the gap where the browser was closed, which is precisely when
 * a poll cannot run.
 */
export function useDrainTrackedResourceLoads() {
  const tracked = useResourceLoadStore((s) => s.tracked);
  const untrack = useResourceLoadStore((s) => s.untrack);
  const drained = useRef(false);

  const ids = tracked.map((x) => x.modelVersionId);
  const { data: states } = trpc.resourceLoad.getState.useQuery(
    { modelVersionIds: ids },
    { enabled: ids.length > 0 }
  );

  useEffect(() => {
    if (drained.current || !states) return;
    drained.current = true;

    const byId = new Map(states.map((s) => [s.modelVersionId, s]));
    for (const item of tracked) {
      const verdict = resourceLoadDrainVerdict(item, byId.get(item.modelVersionId));
      if (verdict.action === 'keep') continue;

      if (verdict.action === 'complete') {
        showSuccessNotification({
          title: 'Model loaded',
          message: `${item.modelName} — ${item.name} is ready to generate with.`,
          // Requires acknowledgement: the whole point is that it survives being away from the
          // screen, so it must not vanish before it is seen.
          autoClose: false,
        });
      }
      untrack(item.modelVersionId);
    }
    // `tracked` is intentionally not a dependency — draining mutates it, and re-running on that
    // change would reconsider items this pass already decided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states, untrack]);

  return tracked;
}

/**
 * Mount once, app-wide, so a finished load is reported wherever the user lands next — not only on
 * the page they started it from.
 */
export function ResourceLoadDrain() {
  useDrainTrackedResourceLoads();
  return null;
}
