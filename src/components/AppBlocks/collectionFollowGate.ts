import { sanitizeAppChromeName } from './appChromeName';

/**
 * SET_COLLECTION_FOLLOW — the shared, PURE decision layer for the collection
 * follow/unfollow HOST BRIDGE. Imported by BOTH real hosts (IframeHost.tsx and
 * PageBlockHost.tsx) so the security decision exists in ONE place rather than
 * being open-coded twice and drifting.
 *
 * ── WHAT THIS BRIDGE REPLACES, AND WHAT THAT COSTS ──────────────────────────
 *
 * A block could already follow a collection over HTTP:
 * `POST /api/v1/blocks/collections/[id]/follow`, gated by `withBlockScope` on the
 * block scope `collections:write:self`. That endpoint stays live and is NOT
 * touched by this bridge (the shipped app still calls it until it releases a
 * version that uses the bridge).
 *
 * The HTTP path provided FOUR guarantees. Three of them carry across the bridge
 * unchanged, by construction:
 *
 *   1. SUBJECT PINNED. HTTP pinned `userId === targetUserId === subject`, so a
 *      block could only ever follow FOR the authenticated caller. On the bridge
 *      the host calls the session-authed `collection.follow` / `collection.
 *      unfollow` tRPC procedures, whose handlers (`followHandler` /
 *      `unfollowHandler`) pass `ctx.user.id` as BOTH `userId` and `targetUserId`.
 *      The block never supplies a user id — there is no field for one on the
 *      wire, and the resolver below would drop it if there were.
 *   2. ANONYMOUS REJECTED. HTTP answered an anonymous block token with 403. Here
 *      the host refuses with `sign-in-required` BEFORE opening any UI or calling
 *      anything (and `protectedProcedure` is the server-side backstop).
 *   3. SAME SERVICES, VERBATIM. `followHandler`/`unfollowHandler` call the exact
 *      `addContributorToCollection` / `removeContributorFromCollection` services
 *      the HTTP endpoint called, which enforce their OWN permission gate (a
 *      private collection the viewer can't follow throws FORBIDDEN). No follow
 *      logic is re-implemented anywhere in this bridge.
 *
 * 🔴 THE FOURTH GUARANTEE IS THE ONE THIS MODULE EXISTS FOR: CONSENT.
 *
 * On HTTP the scope `collections:write:self` WAS the consent step — the viewer
 * agreed to that capability before a token carrying it was ever minted. The
 * bridge deliberately removes that requirement (an app using the bridge no
 * longer declares the write scope at all), and the host acts as the signed-in
 * session user. So without a replacement gate ANY block loaded in a host could
 * silently make the viewer follow arbitrary collections, with no consent step
 * the viewer ever saw. That is a real loosening, and it is not acceptable to
 * ship it silently.
 *
 * The replacement is the platform's OTHER consent idiom, already used for the
 * strictly more dangerous PUBLISH_GENERATION_OUTPUTS bridge: a HOST-CHROME
 * confirm. The host opens its OWN dialog and performs the write only on an
 * explicit click in host chrome — that click IS the consent boundary, and the
 * sandboxed iframe can neither fake it nor restyle it. It is per-action and
 * per-collection, so it is at least as strong as the install-time scope grant it
 * replaces, and unlike that grant it cannot be spent later on a collection the
 * viewer never saw.
 *
 * (The alternative reading — gate the handler on `grantedScopes` containing
 * `collections:write:self` — was rejected deliberately: it would reinstate the
 * exact scope the move exists to remove, leaving the bridge dead for any app
 * that dropped it. Recorded here so a future reader does not re-derive it as an
 * oversight.)
 *
 * ── WHY A SEPARATE PURE MODULE ──────────────────────────────────────────────
 * The two hosts differ in how they learn the viewer (IframeHost: `useCurrentUser`;
 * PageBlockHost: its `viewer` prop) and only the page host has a mod-review
 * sandbox. Everything downstream of those two facts is identical, so it lives
 * here, is unit-tested directly, and each host contributes only its own inputs.
 */

/** A validated, safe-to-act-on SET_COLLECTION_FOLLOW request. */
export type CollectionFollowRequest = {
  requestId: string;
  collectionId: number;
  /** true ⇒ follow, false ⇒ unfollow. */
  follow: boolean;
};

/**
 * The CLOSED set of host-side refusal codes carried on a
 * `COLLECTION_FOLLOW_RESULT` `error`. Stable strings, not prose: the SDK hook
 * branches on them (e.g. to route `sign-in-required` into a REQUEST_SIGN_IN).
 * A SERVER failure is reported with the error's own message instead — those are
 * open-ended by nature and the block only renders them.
 */
export type CollectionFollowRefusal =
  | 'invalid-request'
  | 'sign-in-required'
  | 'review-mode'
  | 'declined';

export type CollectionFollowGateResult =
  /** No usable requestId — there is nothing to reply TO, so drop it silently. */
  | { kind: 'drop' }
  /** Refuse WITH a reply. Never a silent drop: a REQUEST-style message that gets
   *  no reply hangs the block to its SDK timeout (gotcha-#73). */
  | { kind: 'refuse'; requestId: string; error: CollectionFollowRefusal }
  /** Passed every gate — the caller must now open the host-chrome consent
   *  confirm. `confirm`, not `proceed`: this result NEVER authorises a write on
   *  its own, and no caller may act on it without the viewer's click. */
  | { kind: 'confirm'; request: CollectionFollowRequest };

/**
 * Decide what a host should do with a raw SET_COLLECTION_FOLLOW payload from an
 * untrusted iframe.
 *
 * Check ORDER mirrors the HTTP endpoint's, deliberately: identity first, payload
 * second, so an anonymous caller is refused as anonymous rather than as
 * malformed. `reviewNack` comes first because it is the one refusal that must
 * hold even for a perfectly-formed request from a signed-in viewer.
 *
 * @param raw        the untrusted message payload
 * @param signedIn   is a real session user present in the host? (IframeHost:
 *                   `currentUser?.id != null`; PageBlockHost: `viewer != null`)
 * @param reviewNack mod-review sandbox with "run for real" OFF. This op is
 *                   SESSION-authed — it does NOT ride the scope-stripped review
 *                   block token — so without this an untrusted PENDING app under
 *                   review could drive the REVIEWING MOD's real session into
 *                   following arbitrary collections. Same reasoning as the
 *                   GET_WILDCARD_PACK review NACK, which is session-authed for
 *                   the same reason.
 */
export function resolveCollectionFollowRequest({
  raw,
  signedIn,
  reviewNack,
}: {
  raw: unknown;
  signedIn: boolean;
  reviewNack: boolean;
}): CollectionFollowGateResult {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  // No requestId ⇒ nothing to correlate a reply to. Dropping is correct AND
  // safe: a block that sent no requestId is not awaiting anything.
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return { kind: 'drop' };
  const requestId = obj.requestId;

  if (reviewNack) return { kind: 'refuse', requestId, error: 'review-mode' };
  if (!signedIn) return { kind: 'refuse', requestId, error: 'sign-in-required' };

  // `collectionId` must be a positive integer. Numbers only — a numeric STRING
  // is refused rather than coerced, so the wire contract stays one shape.
  const collectionId = obj.collectionId;
  if (
    typeof collectionId !== 'number' ||
    !Number.isInteger(collectionId) ||
    collectionId <= 0 ||
    typeof obj.follow !== 'boolean'
  ) {
    return { kind: 'refuse', requestId, error: 'invalid-request' };
  }

  return { kind: 'confirm', request: { requestId, collectionId, follow: obj.follow } };
}

/**
 * The copy for the host-chrome consent confirm. Shared so both hosts ask the
 * same question — the dialog IS the security boundary, so its wording is part of
 * the guarantee, not decoration.
 *
 * The app name is PUBLISHER-controlled, so it is passed through
 * `sanitizeAppChromeName` (the same anti-spoof used by the visible trust chrome)
 * before being named as the party asking. Mantine renders `message` as React
 * text, so this is not about HTML injection: it is about a bidi override or a
 * control-char run misrepresenting WHO the viewer is granting something to, on
 * the one screen where that matters. Falls back to the literal "This app".
 */
export function buildCollectionFollowConsentCopy({
  follow,
  appName,
}: {
  follow: boolean;
  appName?: string | null;
}): { title: string; message: string; confirmLabel: string } {
  const who = sanitizeAppChromeName(appName) ?? 'This app';
  return follow
    ? {
        title: 'Follow this collection?',
        message: `${who} wants to follow a collection with your Civitai account. It will appear in your collections until you unfollow it.`,
        confirmLabel: 'Follow',
      }
    : {
        title: 'Unfollow this collection?',
        message: `${who} wants to unfollow a collection with your Civitai account. It will be removed from your collections.`,
        confirmLabel: 'Unfollow',
      };
}
