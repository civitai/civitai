/**
 * Lazy-consent gate for the host's REQUEST_CONSENT handler.
 *
 * A block rendered for a LOGGED-IN viewer whose block token is missing a
 * consent-gated scope (e.g. `ai:write:budgeted` / `buzz:read:self` withheld at
 * mint because the viewer hasn't granted them yet) asks the host to open its
 * consent UI when the user clicks an action that needs that capability (e.g.
 * Generate) — instead of prompting on load. usePostMessage already pins origin
 * + event.source; this pure predicate centralises the two remaining host-side
 * conditions so they can be unit-tested without the full iframe postMessage
 * harness (same pattern as resolveRequestSignIn / resolveBuzzPurchaseRequest):
 *
 *   1. status === 'ready' — only honor the request once BLOCK_READY has landed,
 *      so a pre-handshake block can't pop a consent modal before any interaction.
 *   2. missingScopes non-empty — nothing to consent to otherwise (the viewer has
 *      already granted everything the app's approved manifest declares), so the
 *      request is a no-op and dropped.
 *
 * The block MAY send an advisory `scopes` hint, but it is deliberately IGNORED:
 * the host grants the missing set it computed at mint (server-known truth), so a
 * block can't widen the grant beyond what was actually withheld. (grantScopes is
 * itself bounded server-side to manifest∩approved, so this is defense-in-depth.)
 *
 * Returns `null` when the request must be ignored (status not ready, or nothing
 * missing), or the scopes to grant when the consent modal should open.
 */
import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';
import {
  APP_STORAGE_BASE_SCOPE,
  APP_STORAGE_PUBLISH_SCOPE,
} from '~/shared/constants/block-storage.constants';
import { BLOCK_HOST_LOCAL_PREVIEW_STORAGE, type BlockHostSurface } from './blockInitFragmentGate';
import type { HostStatus } from './openBuzzPurchaseGate';
import { resolveRequestSignIn } from './requestSignInGate';

export function resolveRequestConsent(
  status: HostStatus,
  missingScopes: string[]
): string[] | null {
  if (status !== 'ready') return null;
  if (!Array.isArray(missingScopes) || missingScopes.length === 0) return null;
  return missingScopes;
}

/**
 * The scopes a host advertises to the block in BLOCK_INIT / TOKEN_REFRESH /
 * TOKEN_REFRESH_RESPONSE, and the "already granted" set the consent gates read.
 * Shared by both host surfaces so they cannot disagree.
 *
 * `signedScopes` is the set the mint reports it SIGNED into this token, and wins
 * whenever present. Re-deriving it as `declared − missingScopes` is wrong for an
 * anonymous viewer: the mint strips every consent-gated scope but reports
 * `missingScopes: []` (anon cannot consent), so the derivation advertised gated
 * scopes the token lacks — and a REQUEST_CONSENT for one was then read as
 * "already granted" and dropped. On the main mint path it also differs for a
 * signed-in viewer whose manifest still lists a deprecated scope the mint no
 * longer signs, and the private-run and owned dev-tunnel mints sign a clamped
 * set derived from the approved scopes rather than the client's manifest — which
 * can ADD `user:read:self` the manifest never declared (the dev clamp forces it).
 *
 * The derivation stays only as the fallback for a caller that passes no signed
 * set: a mint response without `scopes` (the ephemeral dev-tunnel mint), or
 * ReviewBlockPreviewHost, which passes its review mint's signed set as
 * `declaredScopes` with no `missingScopes`.
 */
export function resolveAdvertisedScopes(
  declaredScopes: string[],
  missingScopes: string[] | undefined,
  signedScopes: string[] | undefined
): string[] {
  if (Array.isArray(signedScopes)) return signedScopes;
  if (!missingScopes || missingScopes.length === 0) return declaredScopes;
  const withheld = new Set(missingScopes);
  return declaredScopes.filter((s) => !withheld.has(s));
}

/** Everything a host needs to decide whether to offer the consent notice itself. */
export type HostConsentNoticeInput = {
  /** The host's gate status, already collapsed onto the shared union. */
  status: HostStatus;
  /**
   * The MINT's own verdict that the viewer's grant is short of the app's approved
   * manifest. Read as the server states it rather than re-derived from
   * `missingScopes`: the host branches on the server's answer, and `undefined`
   * (a legacy mint response that carries no such field) means "no notice".
   */
  needsConsent: boolean | undefined;
  /** The consent-gated scopes the mint withheld from the current token. */
  missingScopes: string[] | undefined;
  /** The app the viewer dismissed the notice for this mount, or `null`. */
  dismissedFor: string | null;
  /** The app being hosted. */
  appBlockId: string;
  /**
   * Hard suppression, independent of every other term — PageBlockHost's
   * `reviewMode`, where a grant would re-mint the MODERATOR's token with wider
   * scopes at the request of unapproved code. Hosts with no sandbox surface
   * (IframeHost) never set it.
   */
  suppressed?: boolean;
};

/**
 * 🔴 THE HOST-SIDE MISSING-PERMISSIONS BACKSTOP, SHARED BY EVERY HOST SURFACE.
 *
 * The mint is FAIL-CLOSED on a missing `app_user_scope_grants` row, so a signed-in
 * viewer who has never consented gets a token with every consent-gated scope
 * withheld. Until this predicate existed the ONLY route back to consent was the
 * BLOCK sending REQUEST_CONSENT — so an app that did not think to ask left the
 * viewer with a working-looking control that could never succeed, permanently and
 * with no host-side signal at all.
 *
 * 🔴 IT LIVES HERE, NOT IN EITHER HOST, BECAUSE THE TWO HOSTS ALREADY DIVERGED ON
 * EXACTLY THIS. `PageBlockHost` grew the backstop; `IframeHost` — the model-slot
 * surface — never did (measured: `needsConsent` appeared 7 times in one file and 0
 * times in the other), so for the whole life of that gap the model slot could reach
 * consent only if the block chose to ask. A second open-coded copy is how that
 * happens again. Both hosts now call THIS, and it delegates the two shared
 * conditions to `resolveRequestConsent` above so the host-OFFERED notice and the
 * block-REQUESTED modal cannot disagree about when consent is offerable.
 *
 * 🔴 A NOTICE, NOT AN AUTO-OPENED MODAL — the caller decides how to render, but the
 * intent of the predicate is an OFFER. A block can be entirely usable unconsented
 * (`collections:read:self` is consent-exempt), so an unconditional modal would
 * interrupt every viewer of every app that merely DECLARES a consent-gated scope.
 *
 * Returns the scopes to consent to, or `null` when no notice is warranted.
 */
export function resolveHostConsentNotice(input: HostConsentNoticeInput): string[] | null {
  if (input.suppressed) return null;
  if (input.dismissedFor === input.appBlockId) return null;
  // `!== true` deliberately, not `!needsConsent`: this is the SERVER's verdict and
  // a legacy response omitting the field must read as "nothing to prompt for".
  if (input.needsConsent !== true) return null;
  return resolveRequestConsent(input.status, input.missingScopes ?? []);
}

/** What an un-grantable (prod-path) REQUEST_CONSENT should produce. */
export type UngrantableConsentNotice = {
  /**
   * Whether the refusal is surfaced at all — the trigger for BOTH the host toast
   * and the CONSENT_UNAVAILABLE bridge push. Computed on the UNFILTERED
   * un-grantable set, so an un-grantable scope outside the known vocabulary
   * still refuses out loud instead of vanishing.
   */
  notify: boolean;
  /**
   * The refused scopes safe to NAME back to the block: the un-grantable subset
   * filtered to the known block-scope vocabulary. Can legitimately be EMPTY
   * while `notify` is true (every requested scope was unrecognised) — the
   * refusal is the signal, the names are advisory.
   */
  scopes: string[];
  /**
   * Whether the VIEWER is prompted (the toast, or sign-in when signed out). Equal
   * to `notify` on every surface except one whose document store is served
   * locally (`BLOCK_HOST_LOCAL_PREVIEW_STORAGE`), where it is false when every
   * refused scope is in {@link LOCAL_PREVIEW_STORAGE_SCOPES}. The block's
   * `CONSENT_UNAVAILABLE` push still follows `notify`.
   */
  promptViewer: boolean;
};

/**
 * The document-store scopes the SDK's in-tab local store serves on a surface
 * whose BLOCK_INIT carries `storageMode: 'local-preview'`. The tunnel mint never
 * signs them, so on that surface they always arrive here as un-grantable, which is
 * expected and not something to tell the viewer about. The same pair `@civitai/sdk`
 * treats as held in a local preview. Shared storage (`apps:storage:shared:*`) and
 * the key/value scopes are NOT here: the local store does not serve them, so a
 * refusal of one is still worth showing.
 */
export const LOCAL_PREVIEW_STORAGE_SCOPES: ReadonlySet<string> = new Set([
  APP_STORAGE_BASE_SCOPE,
  APP_STORAGE_PUBLISH_SCOPE,
]);

/**
 * Issue B (defensive UX): decide whether a REQUEST_CONSENT whose grantable set is
 * EMPTY should surface a user-visible "not available" message instead of the silent
 * no-op that makes an app look dead.
 *
 * A block MAY send an advisory `scopes` hint listing what it wants. The host does
 * NOT use it to GRANT anything (the grant set is bounded server-side to
 * `missingScopes`), but it CAN use it to tell apart two otherwise-identical
 * silent-drop cases when nothing is grantable-via-consent:
 *   - BENIGN (drop silently): every requested scope is ALREADY granted — a block
 *     re-requesting a scope its token already carries.
 *   - UN-GRANTABLE (surface a message): a requested scope is neither currently
 *     granted NOR addable via consent (`missingScopes`) — it was clamped/withheld
 *     at mint (e.g. a dev-tunnel token that stripped a scope the tunnel allowlist
 *     doesn't carry), so the block's consent round-trip can never resolve it.
 *
 * `notify` is false when the hint is absent/garbage OR everything requested is
 * already granted — the caller then keeps the silent no-op (no fragile heuristic:
 * without an explicit requested scope proven un-grantable, we never surface).
 *
 * 🔴 WHY THIS RETURNS TWO FIELDS RATHER THAN ONE LIST (same split, and same
 * reason, as `resolveReviewConsentNotice` in `pageBlockHostLogic`). `rawScopesHint`
 * is UNTRUSTED — it is whatever the block's own frame posted, so it can carry
 * markup, junk, or a 5 KB string. The returned `scopes` therefore pass
 * `isKnownBlockScope`, so only the fixed platform vocabulary is ever echoed back
 * out of the host.
 *
 * That filter must NOT reach the DECISION. The un-grantable set is the trigger as
 * well as the payload: filter the trigger and a block requesting an un-grantable
 * scope the vocabulary doesn't know would get no toast and no bridge message at
 * all — the exact silent dead end this whole path exists to remove, reintroduced
 * by the security fix. So the decision is taken on the unfiltered set and only the
 * NAMES are filtered.
 *
 * Splitting it also depends on `isKnownBlockScope` being an OWN-property test: it
 * used to use `in`, which walks the prototype chain and let 12 inherited
 * `Object.prototype` keys (`constructor`, `__proto__`, `toString`, …) through as
 * "known scopes". Fixed at the predicate; pinned again in the unit tests, because
 * this is a caller that feeds untrusted runtime input to it.
 *
 * 🔴 MOVED HERE FROM `pageBlockHostLogic` — it was never page-specific. It is the
 * REFUSAL half of the same gate `resolveRequestConsent` opens, and while it lived
 * in the page host's own logic module the model-slot host emitted no
 * CONSENT_UNAVAILABLE at all: a block that DID ask got a `requestGrants` promise
 * that could never resolve `false`. `IframeHost` deliberately does not import
 * `pageBlockHostLogic` (the page host is a sibling surface, not a dependency), so
 * the shared gate is the only honest home for this.
 *
 * 🔴 `surface` — the host's own mounted surface, REQUIRED so no caller can forget
 * it. It is read ONLY through `BLOCK_HOST_LOCAL_PREVIEW_STORAGE`, the record that
 * already decides BLOCK_INIT's `storageMode`: one predicate for "storage is local
 * here". Where it is, a refusal made only of document-store scopes does not prompt
 * the viewer. `notify` and the `CONSENT_UNAVAILABLE` push are unchanged, because an
 * SDK that predates local-preview grants waits on that push, and the host cannot
 * put a storage scope on the token to settle it any other way. Nothing is granted,
 * advertised or minted differently.
 */
export function resolveUngrantableConsentNotice(
  rawScopesHint: unknown,
  grantedScopes: string[],
  missingScopes: string[] | undefined,
  surface: BlockHostSurface
): UngrantableConsentNotice {
  if (!Array.isArray(rawScopesHint)) return { notify: false, promptViewer: false, scopes: [] };
  const requested = rawScopesHint.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (requested.length === 0) return { notify: false, promptViewer: false, scopes: [] };
  const granted = new Set<string>(grantedScopes);
  const missing = new Set<string>(missingScopes ?? []);
  const ungrantable = Array.from(
    new Set(requested.filter((s: string) => !granted.has(s) && !missing.has(s)))
  ).sort();
  // Decision on the UNFILTERED set — see above.
  if (ungrantable.length === 0) return { notify: false, promptViewer: false, scopes: [] };
  // Also on the unfiltered set: an unknown scope beside a document-store one must
  // still prompt, for the unknown one.
  const promptViewer = BLOCK_HOST_LOCAL_PREVIEW_STORAGE[surface]
    ? ungrantable.some((s) => !LOCAL_PREVIEW_STORAGE_SCOPES.has(s))
    : true;
  return {
    notify: true,
    promptViewer,
    scopes: ungrantable.filter((s) => isKnownBlockScope(s)),
  };
}

/**
 * What the HOST shows the viewer for an un-grantable REQUEST_CONSENT (the block
 * always gets CONSENT_UNAVAILABLE regardless — this is only the host-frame half).
 *
 * A signed-out viewer's scopes are un-grantable only because they are signed out:
 * the anon mint strips every consent-gated scope, and signing in makes them
 * grantable. "This permission isn't available here" is false for them, and the
 * SDK's `withConsentRetry` sends REQUEST_CONSENT automatically on the first failed
 * gated call per missing scope set (it then remembers the refusal until the token
 * rotates), so a viewer who never asked for a permission would see it. Offer sign-in instead, through the same
 * `resolveRequestSignIn` gate REQUEST_SIGN_IN uses (it refuses before BLOCK_READY,
 * so nothing pops pre-handshake). Signed-in viewers keep the toast.
 */
export type UngrantableConsentPrompt = 'sign-in' | 'toast' | 'none';

export function resolveUngrantableConsentPrompt(
  status: HostStatus,
  signedIn: boolean
): UngrantableConsentPrompt {
  if (signedIn) return 'toast';
  return resolveRequestSignIn(status, undefined) != null ? 'sign-in' : 'none';
}

/**
 * The host toast for an un-grantable REQUEST_CONSENT, shared by every host surface.
 *
 * 🔴 SURFACE-NEUTRAL WORDING, DELIBERATELY. The page host's original copy said
 * "…isn't available in this preview", which was already an overreach there: a
 * dev-tunnel preview is only the worked EXAMPLE of a mint clamp, and the same
 * un-grantable state is reachable on the live page and on the model slot whenever a
 * requested scope is neither granted nor listed in `missingScopes`. Telling a
 * viewer on a model page that they are in a "preview" is simply false, so the
 * clause is gone rather than duplicated with a second per-surface wording.
 */
export const UNGRANTABLE_CONSENT_TOAST = {
  title: 'Permission unavailable',
  message: 'This app requested a permission that isn’t available here.',
} as const;
