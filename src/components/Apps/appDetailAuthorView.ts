/**
 * App Blocks marketplace DETAILS MODAL (`AppDetailsModal`) — AUTHOR ATTRIBUTION
 * view-model (pure, React-free).
 *
 * THE BUG THIS EXISTS TO KILL: the modal rendered `by {detail.appName ??
 * block.appName ?? block.appId}`. `appName` is the OAuth CLIENT's name, and in
 * prod every approved block's `OauthClient.name` equals the APP's own title
 * (verified: `appblk-gen-matrix` → OauthClient name "Gen Matrix", real owner
 * `zachlowdenzx`). So the author slot displayed the app's own title — and the
 * `?? appId` fallback displayed an opaque internal id. Both are wrong, and both
 * looked plausible enough to survive review.
 *
 * 🔴 Why the MODAL and not the `/apps/[appBlockId]` PAGE, which has the same
 * bug: that page is being retired wholesale by a separate PR, and touching it
 * here would make the two PRs collide on one file. The modal sits on the
 * documented one-line `/apps` → `MarketplaceBody` ROLLBACK path, so fixing it
 * here means rolling back does not reintroduce the wrong-author bug. The
 * server-side `PublicAppDetail.owner` allowlist this reads is shared, so
 * whatever surface survives gets the correct attribution.
 *
 * The rule now: attribution comes ONLY from the real owner chip
 * (`PublicAppDetail.owner`, the `{id, username, image}` allowlist). No owner, or
 * an owner with no username → NO attribution line at all. Showing nothing is
 * strictly better than showing a wrong name, and there is nothing else on the
 * DTO that is a person.
 *
 * Pure so the coverage lives in the node `unit` project — the fast,
 * deterministic suite CI runs on every PR (the browser-mode component suites
 * are not run in CI at all).
 */

import type { PublicOwnerChip } from '~/server/services/blocks/public-owner';

export type AppDetailAuthor = {
  username: string;
  /** Profile link — matches the store's `CreatorChip` target. */
  href: string;
  /** Avatar source (raw; the caller runs it through `getEdgeUrl`). */
  image: string | null;
};

/**
 * The author chip for the app-details surface, or `null` when there is no
 * attributable person. NEVER falls back to `appName` / `appId`.
 */
export function getAppDetailAuthor(
  detail: { owner?: PublicOwnerChip | null } | null | undefined
): AppDetailAuthor | null {
  const owner = detail?.owner;
  if (!owner) return null;
  const username = typeof owner.username === 'string' ? owner.username.trim() : '';
  if (!username) return null;
  return {
    username,
    href: `/user/${encodeURIComponent(username)}`,
    image: owner.image ?? null,
  };
}
