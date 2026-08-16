import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { FeatureNotice } from '~/components/Alerts/notice-registry';
import { isNoticeDismissed } from '~/components/Alerts/notice-registry';

export type UseFeatureNoticeResult = {
  /** The notice's id is present in the user's stored `dismissedAlerts`. */
  isDismissed: boolean;
  /**
   * A settings object has resolved, so `isDismissed` reflects stored state
   * rather than the absence of an answer. Gate rendering on this wherever
   * flashing a notice at someone who already dismissed it would be wrong: the
   * settings query is normally SSR-seeded and this is `true` on the first
   * render, but a failed SSR snapshot leaves it `false` until the mount fetch
   * lands.
   */
  hasSettings: boolean;
  /** The settings query is in flight. Weaker than `!hasSettings` — see below. */
  isLoading: boolean;
  /** Persist a dismissal, optimistically. */
  dismiss: () => void;
  /** Undo a dismissal, optimistically. Only meaningful where UI offers it. */
  restore: () => void;
};

/**
 * Read and write one feature notice's dismissed state.
 *
 * Owns the four things every notice used to hand-roll: the settings read, the
 * dismissed predicate, the optimistic cache update with its rollback, and the
 * post-write reconcile.
 *
 * The reconcile (`onSettled` → `invalidate`) is not optional bookkeeping. The
 * optimistic write spreads `...old`, so if the cached base was incomplete — a
 * failed SSR settings snapshot — the optimistic write would persist a TRUNCATED
 * settings object into the cache and every other reader of `user.getSettings`
 * would see it. One refetch per dismiss restores the full object. Dismissals
 * are rare, so this costs one request per dismissal, not one per mount.
 *
 * 🔴 `isLoading` and `hasSettings` are NOT interchangeable. `isLoading` goes
 * false when a query settles, including when it settles as an ERROR, at which
 * point `settings` is still undefined; `hasSettings` stays false. A caller that
 * uses `isLoading` will render the notice on an errored settings fetch — which
 * means showing it to someone who already dismissed it. Prefer `hasSettings`
 * for anything a user can dismiss.
 *
 * Deliberately NOT owned here: WHEN a notice should be shown. Visibility is
 * per-site (a feature flag, a balance, a mount context) and folding it in would
 * mean every site paying for every other site's conditions. Sites compose
 * `hasSettings && !isDismissed && <their own condition>`.
 *
 * @param notice  A registry entry, never a bare string — that is what keeps the
 *                persisted id set enumerable and collision-checkable.
 * @param enabled Extra gate on the settings read, ANDed with "is signed in".
 *                Signed out there is nowhere to record a dismissal.
 */
export function useFeatureNotice(
  notice: FeatureNotice,
  { enabled = true }: { enabled?: boolean } = {}
): UseFeatureNoticeResult {
  const currentUser = useCurrentUser();
  const queryEnabled = enabled && !!currentUser;

  const { data: settings, isLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: queryEnabled,
  });

  const utils = trpc.useUtils();
  const mutation = trpc.user.dismissAlert.useMutation({
    onMutate: async (vars) => {
      // `dismissAlertSchema` defaults `dismiss` to true, so an omitted flag
      // means "dismiss" on the server. Mirror that here rather than reading
      // `vars.dismiss` as a boolean.
      const dismissing = vars.dismiss !== false;
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: dismissing
          ? [...(old?.dismissedAlerts ?? []), notice.id]
          : (old?.dismissedAlerts ?? []).filter((id: string) => id !== notice.id),
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
    onSettled: () => {
      utils.user.getSettings.invalidate();
    },
  });

  return {
    isDismissed: isNoticeDismissed(settings?.dismissedAlerts, notice),
    hasSettings: !!settings,
    isLoading,
    // `dismiss` omits the flag and `restore` sends `false`, matching the wire
    // payloads these call sites have always sent.
    dismiss: () => mutation.mutate({ alertId: notice.id }),
    restore: () => mutation.mutate({ alertId: notice.id, dismiss: false }),
  };
}
