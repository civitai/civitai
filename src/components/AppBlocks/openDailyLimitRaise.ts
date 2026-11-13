import dynamic from 'next/dynamic';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import type { trpc } from '~/utils/trpc';

const DailyLimitRaiseDialog = dynamic(() => import('./DailyLimitRaiseDialog'), { ssr: false });

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/** How long the host's limit read is reused, so an app repeating its request costs one read. */
export const DAILY_LIMIT_READ_STALE_MS = 30_000;
/** After "Not now", the dialog does not open on its own again for this app in this tab. */
export const DAILY_LIMIT_DISMISS_SUPPRESS_MS = 10 * 60_000;

const dismissedAt = new Map<string, number>();

export type DailyLimitRaiseOutcome = 'raised' | 'not-raised' | 'unavailable';

/**
 * Opens the host's raise dialog for one app when there is a limit to raise, and resolves when it
 * closes. `unavailable` means no dialog opened: one is already open for this app, the viewer
 * dismissed one for it recently, the read came back empty (flag off, no limit, spending revoked,
 * rate-limited) or failed, or `requireServerRefusal` is set and the server has no recent refusal
 * at this limit on record.
 */
export async function openDailyLimitRaise(opts: {
  utils: TrpcUtils;
  appBlockId: string;
  appName?: string | null;
  requireServerRefusal?: boolean;
  /** Called just before the dialog opens; not called when the outcome is `unavailable`. */
  onOpened?: () => void;
  now?: number;
}): Promise<DailyLimitRaiseOutcome> {
  const { utils, appBlockId, appName } = opts;
  const now = opts.now ?? Date.now();
  const dismissed = dismissedAt.get(appBlockId);
  if (dismissed !== undefined && now - dismissed < DAILY_LIMIT_DISMISS_SUPPRESS_MS) {
    return 'unavailable';
  }
  let data: Awaited<ReturnType<typeof utils.blocks.getMyAppDailyLimit.fetch>>;
  try {
    data = await utils.blocks.getMyAppDailyLimit.fetch(
      { appBlockId },
      { staleTime: DAILY_LIMIT_READ_STALE_MS }
    );
  } catch {
    return 'unavailable';
  }
  if (!data) return 'unavailable';
  if (opts.requireServerRefusal && !data.refusedRecently) return 'unavailable';

  const id = `block-daily-limit-${appBlockId}`;
  if (useDialogStore.getState().dialogs.some((d) => d.id === id)) return 'unavailable';
  opts.onOpened?.();
  return new Promise((resolve) => {
    let raised = false;
    dialogStore.trigger({
      id,
      component: DailyLimitRaiseDialog,
      props: {
        appBlockId,
        appName,
        limit: data.limit,
        spentToday: data.spentToday,
        onRaised: () => {
          raised = true;
        },
      },
      options: {
        onClose: () => {
          if (!raised) dismissedAt.set(appBlockId, Date.now());
          resolve(raised ? 'raised' : 'not-raised');
        },
      },
    });
  });
}

/** Test seam: forget every "Not now" in this tab. */
export function resetDailyLimitRaiseSuppression(): void {
  dismissedAt.clear();
}
