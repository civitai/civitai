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
 * 🔴 THE FOURTH THING IS CONSENT — AND ON HTTP THERE WAS NONE. THIS BRIDGE IS A
 *    TIGHTENING, NOT A LOOSENING.
 *
 * ⚠️ RETRACTED CLAIM, recorded so it is not re-derived. Every earlier copy of
 * this comment (and the PR that introduced it) asserted: *"on HTTP the scope
 * `collections:write:self` WAS the consent step — the viewer agreed to that
 * capability before a token carrying it was ever minted."* **That is false.**
 * `collections:write:self` is listed in `CONSENT_EXEMPT_SCOPES`
 * (`src/server/services/blocks/scope-grant.service.ts`), commented *"server
 * visibility/ownership is the gate, not a per-scope consent prompt"*.
 * `partitionByConsent` puts it straight into `signable`, `consentGatedScopes`
 * strips it, and NO grant row is ever recorded. `block-scope.constants.ts` says
 * the same thing at the registry. So the viewer was never prompted, at install
 * time or ever: on HTTP a block that merely DECLARED the scope could follow
 * arbitrary collections for the viewer with ZERO prompts.
 *
 * What the bridge therefore does is convert a ZERO-prompt path into a
 * ONE-PROMPT-PER-ACTION path. A reviewer weighing "is this loosening
 * acceptable?" is answering a question that does not exist.
 *
 * WHAT IT DOES COST, precisely: the manifest `scopes` declaration. That string
 * is the EX-ANTE REVIEWABILITY signal — a moderator sees it in
 * `OnsiteReviewModal` and the viewer inspects it post-install in
 * `AppSettingsModal`. An app on the bridge declares no write scope, so its
 * permissions panel can read EMPTY while it writes to the viewer's collections.
 * The real trade is:
 *
 *     "reviewable before install"  →  "consented at the moment of action"
 *
 * The replacement gate is the platform's OTHER consent idiom, already used for
 * the strictly more dangerous PUBLISH_GENERATION_OUTPUTS bridge: a HOST-CHROME
 * confirm. The host opens its OWN dialog and performs the write only on an
 * explicit click in host chrome — that click IS the consent boundary, and the
 * sandboxed iframe can neither fake it nor restyle it. It is per-action and
 * per-collection, and it names the collection the host itself resolved (see
 * `resolveCollectionIdentity` below), so it cannot be spent on a collection the
 * viewer never saw.
 *
 * 🔴 DO NOT "restore" the scope gate as a fix for the retracted claim above, and
 * do NOT delete this confirm as redundant with a scope grant. There is no scope
 * grant. The confirm is the ONLY consent this path has ever had.
 *
 * (The alternative reading — gate the handler on `grantedScopes` containing
 * `collections:write:self` — was rejected deliberately: `grantedScopes` never
 * contains it (it is consent-exempt, so no grant row exists to put it there), so
 * such a gate would be dead code that refuses every request. Recorded here so a
 * future reader does not re-derive it as an oversight.)
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
  | 'declined'
  /** The host has not completed the block handshake yet, so there has been no
   *  user interaction this prompt could plausibly belong to. See `ready` on
   *  `resolveCollectionFollowRequest`. */
  | 'not-ready'
  /** The host could not resolve the collection's identity — it does not exist,
   *  the viewer may not see it, or the lookup itself failed. 🔴 ONE code for all
   *  three, DELIBERATELY: a distinct "not found" would let a block enumerate
   *  private collection ids by asking the host to name them. Existence-leak
   *  parity with the read path, which 404s a private collection to a non-owner.
   *
   *  ALSO the code for a lookup the host REFUSED TO PERFORM because the block
   *  exhausted its per-instance lookup budget (`createCollectionLookupBudget`).
   *  🔴 THAT SHARING IS THE POINT, not an economy: a distinct "rate limited" code
   *  would hand back exactly the bit the budget exists to withhold. See the
   *  budget's own comment for the oracle it closes. */
  | 'collection-unavailable';

export type CollectionFollowGateResult =
  /** No usable requestId — there is nothing to reply TO, so drop it silently. */
  | { kind: 'drop' }
  /** Refuse WITH a reply. Never a silent drop: a REQUEST-style message that gets
   *  no reply hangs the block to its SDK timeout (gotcha-#73). */
  | { kind: 'refuse'; requestId: string; error: CollectionFollowRefusal }
  /** Passed every gate — the caller must now RESOLVE THE COLLECTION'S IDENTITY
   *  server-side and open the host-chrome consent confirm naming it.
   *  `confirm`, not `proceed`: this result NEVER authorises a write on its own,
   *  and no caller may act on it without the viewer's click. */
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
 * @param ready      has the block completed its handshake (host gate status
 *                   `ready`)? 🔴 A pre-handshake block must not be able to pop a
 *                   permission modal before the viewer has interacted with it at
 *                   all — the posture three sibling handlers already document
 *                   (`IframeHost` REQUEST_SIGN_IN / REQUEST_CONSENT,
 *                   `PageBlockHost` navigation). Precedent among the REQUEST-style
 *                   handlers is genuinely MIXED — OPEN_RESOURCE_PICKER,
 *                   PUBLISH_GENERATION_OUTPUTS and OPEN_IMAGE_UPLOAD are all
 *                   ungated — so this is not "the house style"; it is gated
 *                   because this is the only one of them that performs an ACCOUNT
 *                   WRITE. Refused WITH a reply, never dropped: the ungated
 *                   siblings can afford silence, a REQUEST-style message cannot.
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
  ready,
  signedIn,
  reviewNack,
}: {
  raw: unknown;
  ready: boolean;
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
  // Before the viewer, before the payload: `not-ready` is a statement about the
  // HOST's lifecycle, and a pre-handshake caller has no standing to learn either.
  if (!ready) return { kind: 'refuse', requestId, error: 'not-ready' };
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
 * The collection's identity AS THE HOST RESOLVED IT — never as the block
 * described it.
 *
 * 🔴 THIS IS WHAT MAKES THE CONFIRM A CONSENT SCREEN RATHER THAN A CEREMONY.
 * The dialog previously named no collection at all, only the app: *"X wants to
 * follow a collection with your Civitai account."* A block could render its own
 * card reading "Follow ⭐ Cute Cats", post `collectionId: 900123` for something
 * else entirely, and the host chrome would assert NOTHING about the object — so
 * it could not contradict the block, and the module's own per-collection claim
 * was empty. The host now fetches the identity from the id itself and names
 * that.
 *
 * 🔴 AND IT MUST STAY HOST-FETCHED. Do NOT add a block-supplied `name` to the
 * wire and render it: that hands the misrepresentation surface straight back,
 * with the host's own chrome vouching for it. The only trustworthy string is one
 * the host resolved server-side from the same `collectionId` it is about to act
 * on.
 */
export type CollectionIdentity = {
  /** Sanitized display name; `null` when absent or when nothing legible remains. */
  name: string | null;
  /** Sanitized owner username; `null` when absent or illegible. */
  ownerUsername: string | null;
};

export type CollectionIdentityResult =
  | { kind: 'ok'; identity: CollectionIdentity }
  /** Not found, not visible to this viewer, or the lookup failed — ONE outcome
   *  for all three on purpose (see `collection-unavailable`). */
  | { kind: 'unavailable' };

/**
 * Read a `collection.getById` result into a display identity.
 *
 * Duck-typed over `unknown` rather than typed against the tRPC output on
 * purpose: this is a display-safety boundary, so a shape that is not what we
 * expect must land in `unavailable`, not in a render of `undefined`.
 *
 * 🔴 EXISTENCE-LEAK PARITY. `getCollectionByIdHandler` already answers a viewer
 * with no read permission with `{ collection: null }` — the SAME shape a
 * nonexistent id produces — so mapping "no `collection` object" to `unavailable`
 * inherits that non-leak instead of inventing a second, weaker rule. A thrown
 * lookup (NOT_FOUND, feature flag, network) is folded into the same outcome by
 * the caller.
 *
 * Both strings go through `sanitizeAppChromeName`. Despite the name that helper
 * is the host's generic *chrome text* sanitizer, and the reason applies verbatim
 * here: these are OTHER USERS' strings rendered in the one place the viewer is
 * deciding whom to trust, so a bidi override or a Zalgo run must not be able to
 * reorder or overflow the sentence. Mantine renders `message` as React text, so
 * this is not about HTML injection.
 */
export function resolveCollectionIdentity(raw: unknown): CollectionIdentityResult {
  if (!raw || typeof raw !== 'object') return { kind: 'unavailable' };
  const collection = (raw as { collection?: unknown }).collection;
  if (!collection || typeof collection !== 'object') return { kind: 'unavailable' };
  const obj = collection as { name?: unknown; user?: unknown };
  const name = typeof obj.name === 'string' ? sanitizeAppChromeName(obj.name) : null;
  const user = obj.user;
  const username =
    user &&
    typeof user === 'object' &&
    typeof (user as { username?: unknown }).username === 'string'
      ? sanitizeAppChromeName((user as { username: string }).username)
      : null;
  return { kind: 'ok', identity: { name, ownerUsername: username } };
}

/**
 * How many DISTINCT `collectionId`s one block instance may ask the host to
 * resolve. Small on purpose — see the reasoning on
 * `createCollectionLookupBudget`.
 */
export const COLLECTION_LOOKUP_BUDGET = 20;

/**
 * Per-block-instance ledger bounding how many distinct collection ids a block
 * may make the host look up.
 *
 * ── THE ORACLE THIS CLOSES ──────────────────────────────────────────────────
 *
 * `resolveCollectionIdentity` above is what makes the consent dialog name its
 * object, and it costs one authenticated `collection.getById` performed BY THE
 * HOST, IN THE VIEWER'S SESSION, BEFORE any dialog opens. So the block learns
 * `collection-unavailable` vs. dialog-shown with no click and no viewer
 * involvement at all — i.e. per id, "can this viewer see it?".
 *
 * That matters because a sandboxed cross-origin block cannot make authenticated
 * requests to civitai.com itself. Everything it can reach on its own is the
 * anonymous view. The host doing an authed read on its behalf therefore grants a
 * capability the block does not otherwise have, and the transport is fast: the
 * postMessage bridge admits 30 messages/second (`RATE_LIMIT_MAX_MESSAGES` in
 * `usePostMessage.ts`), ~1800 probes/minute. Most collections are public, so
 * most of those answers reveal nothing; the answer that does is *which private
 * collections this viewer can see*.
 *
 * 🔴 WHY A DISTINCT-ID CAP AND NOT A TIME WINDOW. A time-based rate limit slows
 * enumeration; it does not stop it — an attacker with a background tab has all
 * the time there is, and a window also gives them a clean "wait and retry"
 * signal. Enumeration needs hundreds to millions of ids; legitimate use is the
 * handful of collections the viewer is actually looking at in this block. A cap
 * on DISTINCT ids therefore separates the two by their defining property rather
 * than by their speed, and it cannot be waited out.
 *
 * 🔴 WHY THE REFUSAL SHARES `collection-unavailable`. A separate "rate limited"
 * code would let the block tell "I am capped" from "you cannot see it" — the
 * exact bit the cap withholds — and in a time-window design it would also tell
 * an attacker precisely when to back off. What the shared code guarantees is
 * that a refusal past the cap carries NO FACT ABOUT THE COLLECTION. (It does not
 * try to hide the cap itself, which would be futile: the cap is deterministic,
 * so a block counting its own distinct ids can infer where it is. That is
 * information about the block's own behaviour, not about the viewer's account.)
 *
 * ── THE LEDGER ─────────────────────────────────────────────────────────────
 *
 * `admit` counts DISTINCT ids, not calls, and remembers every id it admitted:
 *  - a REPEAT of an already-admitted id is always allowed, forever, even long
 *    past the cap. Re-following (or unfollowing, or re-following again) a
 *    collection the viewer has already been asked about must never stop working,
 *    and a repeat teaches the block nothing it was not already told.
 *  - a NEW id is admitted only while fewer than `limit` distinct ids have been.
 *  - admission is charged at ATTEMPT, not at success. Charging only successful
 *    lookups would leave probing for invisible ids free, which is the entire
 *    attack.
 *
 * 🔴 THE LEDGER MUST BE PER BLOCK INSTANCE — a `useRef` in each host, never
 * module scope. Module scope would let two blocks (or two hosts) on one page
 * share and drain each other's budget, and would survive a remount. Per-instance
 * means the budget resets when the viewer navigates away and back, which is
 * correct: that is a new block session with fresh viewer intent.
 *
 * 🔴 A BLOCK CANNOT RESET IT BY RELOADING ITSELF. The ref lives on the HOST
 * component; `PageBlockHost`'s retry path remounts the IFRAME (`key={reloadNonce}`
 * on the element), not the host, so a block that crashes or reloads in a loop
 * keeps the same ledger. Only the host component unmounting — viewer navigation —
 * clears it, and a block cannot cause that. Do not move this ref onto anything
 * keyed by `reloadNonce`.
 *
 * 🔴 IT DOES NOT — AND MUST NOT — SKIP THE LOOKUP AND SHOW AN OBJECT-LESS
 * DIALOG. "Over budget ⇒ ask the viewer anyway, without naming the collection"
 * would resurrect the defect the naming fix closed: a dialog that asserts
 * nothing about the object cannot contradict whatever card the block drew. Over
 * budget REFUSES; it never degrades the consent screen.
 */
export type CollectionLookupBudget = {
  /**
   * May the host resolve this id? `true` also RECORDS the id (idempotently), so
   * calling it twice for the same id spends one unit, not two.
   */
  admit: (collectionId: number) => boolean;
};

export function createCollectionLookupBudget(
  limit: number = COLLECTION_LOOKUP_BUDGET
): CollectionLookupBudget {
  const admitted = new Set<number>();
  return {
    admit: (collectionId: number) => {
      // Repeat of an id this instance already spent budget on — free, forever.
      if (admitted.has(collectionId)) return true;
      if (admitted.size >= limit) return false;
      admitted.add(collectionId);
      return true;
    },
  };
}

/**
 * Exactly-once reply + CONSENT LATCH for one SET_COLLECTION_FOLLOW request.
 * Shared by both hosts so the two bridges cannot drift on the invariant below.
 *
 * 🔴 `declined` MUST MEAN "NO WRITE OCCURRED". Without the latch it did not.
 * `ConfirmDialog.handleConfirm` awaits `onConfirm()` BEFORE closing its Modal,
 * and the Modal keeps `closeOnEscape` / `closeOnClickOutside` live during that
 * await — so ESC or an overlay click mid-flight ran `onCancel`, won the
 * exactly-once latch with `{error:'declined'}`, and the mutation completed
 * anyway. Measured on the real dialog: the follow mutation fired once and the
 * only reply the block ever saw was `declined`. A block (or a future audit)
 * reading `declined` as "safe, nothing happened" would then be wrong.
 *
 * WHY THIS FIX rather than `closeOnEscape={false}` / `closeOnClickOutside={false}`:
 * those props would have to be threaded through `ConfirmDialog`, a component
 * shared by ~100 unrelated call sites, and they only make the dismissal HARDER —
 * they do not pin the invariant. Trapping the viewer in a modal during a network
 * call is also worse UX than letting it close. This latch pins the invariant
 * itself, in the one module both hosts already share, and is directly unit
 * testable. The dismissal still closes the dialog; it just no longer claims a
 * write did not happen.
 */
export type CollectionFollowSettlement = {
  /** Called SYNCHRONOUSLY at the top of `onConfirm`, before any `await`. */
  markConsented: () => void;
  /** Reply once; every later call is a no-op. */
  reply: (payload: Record<string, unknown>) => void;
  /** Dismissal (Cancel / X / ESC / overlay). A no-op once consent was given. */
  decline: () => void;
};

export function createCollectionFollowSettlement({
  requestId,
  emit,
}: {
  requestId: string;
  emit: (payload: Record<string, unknown>) => void;
}): CollectionFollowSettlement {
  let settled = false;
  let consented = false;
  const reply = (payload: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    emit({ requestId, ...payload });
  };
  return {
    markConsented: () => {
      consented = true;
    },
    reply,
    decline: () => {
      // Consent already given ⇒ the write is in flight or done and will settle
      // this request itself. Reporting `declined` here would be a lie.
      if (consented) return;
      reply({ error: 'declined' });
    },
  };
}

/**
 * The copy for the host-chrome consent confirm. Shared so both hosts ask the
 * same question — the dialog IS the security boundary, so its wording is part of
 * the guarantee, not decoration.
 *
 * Two untrusted-ish strings appear here and BOTH are host-controlled by the time
 * they arrive:
 *  - `appName` is PUBLISHER-controlled and is sanitized here (falls back to the
 *    literal "This app");
 *  - `collection` is HOST-FETCHED and already sanitized by
 *    `resolveCollectionIdentity`. It is never taken from the block.
 *
 * 🔴 THE SENTENCE MUST NAME THE OBJECT. When the fetched name is missing or
 * sanitizes away we fall back to the numeric id (`collection #900123`) rather
 * than to the old object-less wording — an id the viewer can at least compare
 * against what the block showed is strictly more than nothing, and it keeps the
 * host asserting *something* about the thing it is about to follow.
 */
export function buildCollectionFollowConsentCopy({
  follow,
  appName,
  collectionId,
  collection,
}: {
  follow: boolean;
  appName?: string | null;
  collectionId: number;
  collection: CollectionIdentity;
}): { title: string; message: string; confirmLabel: string } {
  const who = sanitizeAppChromeName(appName) ?? 'This app';
  const subject = collection.name
    ? collection.ownerUsername
      ? `“${collection.name}” by ${collection.ownerUsername}`
      : `“${collection.name}”`
    : `collection #${collectionId}`;
  return follow
    ? {
        title: 'Follow this collection?',
        message: `${who} wants to follow ${subject} with your Civitai account. It will appear in your collections until you unfollow it.`,
        confirmLabel: 'Follow',
      }
    : {
        title: 'Unfollow this collection?',
        message: `${who} wants to unfollow ${subject} with your Civitai account. It will be removed from your collections.`,
        confirmLabel: 'Unfollow',
      };
}
