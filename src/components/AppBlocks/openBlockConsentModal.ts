import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

// Lazy-consent UI. Opened on demand — either because the block fired
// REQUEST_CONSENT on an action click, or because the viewer clicked "Review
// permissions" on the host's own missing-permissions notice.
const BlockConsentModal = dynamic(() => import('./BlockConsentModal'), { ssr: false });

export type OpenBlockConsentModalArgs = {
  appBlockId: string;
  /** Display name for the app, as the surface knows it. */
  blockName?: string;
  /**
   * The scopes to consent to — always the MINT's `missingScopes` (server-known
   * truth) as narrowed by `resolveRequestConsent`, never anything the block
   * claimed. `grantScopes` is itself bounded server-side to manifest∩approved, so
   * that is defence in depth rather than the only bound.
   */
  missingScopes: string[];
  /** Called after the grant lands so the host can re-mint the block token. */
  onGranted: () => void;
};

/**
 * 🔴 ONE OPENER, EVERY CALLER, ON PURPOSE.
 *
 * There are now four call sites across two host surfaces — each host's
 * REQUEST_CONSENT handler plus each host's own missing-permissions notice — and an
 * inline `dialogStore.trigger` at any of them is the same rule in another place.
 * They would drift on the first prop that changes, and the props matter: the modal
 * writes a scope GRANT.
 *
 * 🔴 THE STABLE ID IS LOAD-BEARING, BECAUSE `trigger` DEDUPES ON `id` AND NOTHING
 * ELSE. Without one it falls back to `Date.now()` (`dialogStore.ts:47`), so two
 * clicks in different milliseconds stack TWO consent modals. That was latent for as
 * long as the only callers were message handlers; a host-rendered notice is a
 * HUMAN-clickable trigger, which is what makes it reachable.
 *
 * ⚠️ AND IT WAS ALREADY MISSING ON ONE SURFACE. `PageBlockHost` carried this id;
 * `IframeHost` open-coded the trigger with no `id` at all. Centralising here is what
 * closes that, rather than copying the id into a second literal — measured on
 * `origin/main`: one host had the guard, the other did not.
 */
export function openBlockConsentModal({
  appBlockId,
  blockName,
  missingScopes,
  onGranted,
}: OpenBlockConsentModalArgs) {
  dialogStore.trigger({
    id: `block-consent-${appBlockId}`,
    component: BlockConsentModal,
    props: { appBlockId, blockName, missingScopes, onGranted },
  });
}
