import type { SubscriptionRecord } from '~/server/schema/blocks/subscription.schema';
// Re-export so the colocated node-env test can import the type via a
// relative path — the LSP/test tsconfig doesn't reliably resolve the `~/`
// alias for files under src/pages/apps/__tests__.
export type { SubscriptionRecord };

/**
 * One row in the unified /apps/installed Installs tab — one entry per
 * installed app (keyed on appBlockId), collapsing the two blanket
 * "surfaces" (publisher / viewer) plus any pinned-to-a-specific-model
 * subscriptions into a single record.
 *
 * The two blanket surfaces are independent shapes of the SAME app:
 *   - blanketPublisher (scope publisher_all_my_models): the app shows on
 *     the user's OWN models, visible to anyone who views them.
 *   - blanketViewer (scope viewer_personal): the app shows on EVERY model
 *     page the user visits, visible only to them.
 * An app can be on both at once (or neither, if only pinned).
 *
 * `pinned[]` holds the per-model installs — subscriptions with
 * `slotId != null && targetModelIds.length > 0` — regardless of scope.
 */
export type GroupedApp = {
  appBlockId: string;
  blockId: string;
  appId: string;
  manifest: SubscriptionRecord['manifest'];
  blanketPublisher?: SubscriptionRecord;
  blanketViewer?: SubscriptionRecord;
  pinned: SubscriptionRecord[];
};

/**
 * A subscription is the pinned (per-model-install) shape when it has a
 * non-null slotId AND a non-empty targetModelIds array. Otherwise it's a
 * blanket subscription of its scope.
 */
function isPinned(sub: SubscriptionRecord): boolean {
  return (
    sub.slotId != null &&
    Array.isArray(sub.targetModelIds) &&
    sub.targetModelIds.length > 0
  );
}

/**
 * Collapse a flat list of subscriptions into one GroupedApp per app
 * (appBlockId). Returned array is sorted by `manifest.name ?? blockId`
 * (case-insensitive locale compare), stable within ties; `pinned[]` is
 * sorted stable by id.
 *
 * Pure — does not mutate the input.
 */
export function groupSubscriptionsByApp(
  subs: SubscriptionRecord[]
): GroupedApp[] {
  const byApp = new Map<string, GroupedApp>();

  for (const sub of subs) {
    let group = byApp.get(sub.appBlockId);
    if (!group) {
      group = {
        appBlockId: sub.appBlockId,
        blockId: sub.blockId,
        appId: sub.appId,
        manifest: sub.manifest,
        pinned: [],
      };
      byApp.set(sub.appBlockId, group);
    }

    if (isPinned(sub)) {
      group.pinned.push(sub);
    } else if (sub.scope === 'publisher_all_my_models') {
      group.blanketPublisher = sub;
    } else {
      group.blanketViewer = sub;
    }
  }

  for (const group of byApp.values()) {
    group.pinned.sort((a, b) => a.id.localeCompare(b.id));
  }

  const sortKey = (g: GroupedApp) => (g.manifest.name ?? g.blockId).toLocaleLowerCase();
  return Array.from(byApp.values()).sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b))
  );
}
