import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';

/**
 * The decision + settlement layer for the `CREATE_POST_FROM_APP` host bridge.
 *
 * Everything here is PURE and host-agnostic so the rules below cannot drift
 * between hosts (today only `PageBlockHost` registers — see the INVENTORY entry
 * for why the model slot is N/A — but the follow bridge's history is that a
 * second host arrives later and re-derives the rules slightly differently).
 *
 * ## Why this module exists at all, rather than the logic living in the handler
 *
 * Three invariants on this path are easy to state and easy to get wrong, and all
 * three are UNTESTABLE inside a React effect:
 *
 *   1. EXACTLY ONE REPLY. The message is REQUEST-style, so every terminal path —
 *      no token, refusal, preview failure, cancel, success, error — must reply
 *      exactly once. A missed reply hangs the block for TEN MINUTES (the `human`
 *      timeout bucket, not the 30 s protocol one), with no error and no network
 *      call for the author to see.
 *
 *   2. `declined` MUST MEAN "NO POST WAS CREATED". `ConfirmDialog.handleConfirm`
 *      awaits `onConfirm()` BEFORE closing its Modal, and the Modal keeps
 *      `closeOnEscape` / `closeOnClickOutside` LIVE during that await. So an ESC
 *      mid-flight runs `onCancel`, wins a naive exactly-once latch with
 *      `{error:'declined'}`, and the post lands anyway. This is not theoretical:
 *      it was MEASURED on the real dialog for the collection-follow bridge, and
 *      `PUBLISH_GENERATION_OUTPUTS` still carries the un-fixed version (a bare
 *      `settled` boolean). A block — or a future audit — reading `declined` as
 *      "safe, nothing happened" would be wrong, and here "nothing happened" is a
 *      claim about a PUBLIC POST under the viewer's name.
 *
 *   3. A DROPPED PAYLOAD IS ONLY SAFE BEFORE `requestId` IS KNOWN. Dropping on a
 *      missing/garbage `requestId` is safe — nothing is awaiting a reply. After
 *      that, every failure must REPLY, never return null.
 *
 * ## The consent doctrine, stated once
 *
 * 🔴 EVERY WORD THE DIALOG SHOWS ABOUT WHAT WILL BE PUBLISHED COMES FROM THE
 * SERVER, NEVER FROM THE BLOCK. The block is a sandboxed iframe; it can render
 * "Share to your profile" over a button that posts something else entirely. Host
 * chrome that merely repeats the block's own strings asserts nothing and is a
 * ceremony, not a consent screen. So `buildCreatePostConsentCopy` takes a
 * `BlockPostPreview` — the server's resolution of the request.
 *
 * ⚠️ TWO VALUES ARE BLOCK-INFLUENCED, NOT ONE, AND BOTH ARE SANITIZED. This
 * comment used to assert `appName` was the only one, and that was FALSE:
 *   - `appName` — PUBLISHER-controlled (not iframe-controlled).
 *   - `preview.droppedTags` — the block's OWN requested tag strings, echoed back
 *     because a name that resolved to no `Tag` row is reported to the viewer
 *     rather than silently discarded. The server bounds them (≤5 names, ≤100
 *     chars each, control/format chars stripped in `normalizeBlockPostTagNames`),
 *     but they are block text on the consent surface, so they get the same
 *     anti-spoof pass as the app name here.
 * Everything else — title, detail, the RESOLVED tag names, images, gallery — is
 * server-derived. If a third block-influenced value is ever added to the preview,
 * ADD IT TO THIS LIST AND TO THE SANITIZE PASS; the absolute this comment used to
 * state is what let the second one through unnoticed.
 *
 * That is the same rule `collectionFollowGate.ts` states for the follow bridge
 * ("IT MUST STAY HOST-FETCHED. Do NOT add a block-supplied `name` to the wire and
 * render it"), and it binds harder here: the follow confirm names ONE object, and
 * this one names the copy, the tags, the images and the destination.
 *
 * ⚠️ Note what the EXISTING publish confirm does by contrast — it shows only a
 * COUNT and the app name, and does not sanitize `appName` at its call site. That
 * is a weaker bar than this feature needs and is deliberately not copied.
 */

/** The server-resolved consent payload. Mirrors `BlockPostPreview` on the server. */
export type CreatePostPreview = {
  title: string | null;
  detail: string | null;
  tags: string[];
  droppedTags: string[];
  images: Array<{ url: string; width: number | null; height: number | null }>;
  gallery: { modelVersionId: number; modelName: string; versionName: string } | null;
};

/**
 * The refusal codes the HOST itself emits, as opposed to the free-text server
 * messages that also flow through the same `error` field.
 *
 * 🔴 THE REPLY'S `error` MUST STAY SHAPE-CHECKED, NEVER MEMBERSHIP-CHECKED, AND
 * THIS CONSTANT IS NOT A LICENCE TO CHANGE THAT. The SDK has one validator that
 * constrains an error to an enum (`isValidWildcardPackResult`) and one that
 * deliberately does not (`isValidCollectionFollowResult`), and the second one
 * carries the reasoning: a reply failing validation is DROPPED at the top of the
 * transport, before correlation, so the pending request is never rejected — it
 * just sits until its own timer fires. For a consent-gated message that timer is
 * TEN MINUTES. Constraining `error` to a set would therefore convert every
 * server failure ("this app may not attach posts to its own publisher's models",
 * a rate limit, a blocked title) into a wedged button with no network call and
 * no error for the author to see.
 *
 * So: this exists so the host's OWN codes are greppable, typed, and stable for a
 * block that wants to branch on them — `satisfies readonly string[]` keeps them
 * string-typed rather than widening — and the SDK-side validator must accept any
 * string. The union is the set a block can RELY on, not the set it may RECEIVE.
 */
export const CREATE_POST_HOST_ERRORS = [
  /** Mod-review sandbox with run-for-real off. */
  'review-mode',
  /** The block has not finished loading. */
  'block is not ready',
  /** Anonymous viewer — there is no profile to post to. */
  'sign in to post',
  /** The payload named no sources, or the server resolved none. */
  'no images to post',
  /** The host holds no block token yet. */
  'no block token',
  /** The viewer dismissed the confirm. Guaranteed to mean NO post was created. */
  'declined',
] as const satisfies readonly string[];

export type CreatePostHostError = (typeof CREATE_POST_HOST_ERRORS)[number];

export type CreatePostGateDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: CreatePostHostError }
  | {
      kind: 'proceed';
      request: {
        requestId: string;
        sources: unknown;
        title?: string;
        detail?: string;
        tags?: string[];
        modelVersionId?: number;
      };
    };

/**
 * Exactly-once reply + CONSENT latch for one `CREATE_POST_FROM_APP` request.
 * See invariants 1 and 2 in the module docblock — this is their implementation,
 * and it is adopted from `createCollectionFollowSettlement` (the FIXED shape)
 * rather than from the publish handler's bare `settled` boolean (the broken one).
 */
export type CreatePostSettlement = {
  /** Called SYNCHRONOUSLY at the top of `onConfirm`, before any `await`. */
  markConsented: () => void;
  /** Reply once; every later call is a no-op. */
  reply: (payload: Record<string, unknown>) => void;
  /** Dismissal (Cancel / X / ESC / overlay). A no-op once consent was given. */
  decline: () => void;
};

export function createPostSettlement({
  requestId,
  emit,
}: {
  requestId: string;
  emit: (payload: Record<string, unknown>) => void;
}): CreatePostSettlement {
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
      // this request itself. Replying `declined` here would be a lie about
      // whether a public post exists.
      if (consented) return;
      reply({ error: 'declined' });
    },
  };
}

/**
 * Validate a raw `CREATE_POST_FROM_APP` payload from an untrusted iframe and
 * decide drop / refuse / proceed.
 *
 * 🔴 THE SANITISATION HERE IS SHAPE ONLY AND IS NOT A SECURITY BOUNDARY. Every
 * value that survives is re-validated server-side by `previewPostFromApp` and
 * AGAIN by `createPostFromApp`; this pass exists so a garbage payload becomes a
 * legible refusal instead of a server error, and so the handler below can rely on
 * `requestId` being a usable string. In particular it does NOT bound text length,
 * screen content, cap tags, or check `sources` beyond "is an array" — doing any
 * of that here would invite the reading that the client is the gate.
 *
 * `signedIn` is the one REFUSAL this layer owns, because it is the one fact the
 * host knows and the server would otherwise answer with a confusing 401 after a
 * round trip: there is no anonymous profile to post to.
 */
export function resolveCreatePostRequest(input: {
  raw: unknown;
  /** Host gate status — the block must be fully ready before it can post. */
  ready: boolean;
  /** True only for a signed-in viewer. */
  signedIn: boolean;
  /**
   * TRUE when this host is the MOD-REVIEW SANDBOX with "run for real" OFF.
   *
   * 🔴 IT IS THE FIRST REFUSAL, AND IT WOULD STILL BE CORRECT IF IT WERE LAST.
   * A review token can never carry `posts:write:self` — the scope is deliberately
   * absent from BOTH review mint allowlists, so the server refuses regardless.
   * This check exists so the refusal is IMMEDIATE and legible ("review-mode")
   * instead of a scope 403 after a round trip, and so a moderator previewing an
   * unapproved app is never shown a consent dialog for a post that cannot happen.
   * Do not remove it as redundant: it is the client half of a defence whose
   * server half lives in a different repo directory.
   */
  reviewNack: boolean;
}): CreatePostGateDecision {
  const { raw, ready, signedIn, reviewNack } = input;
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  // No usable requestId ⇒ nothing is awaiting a reply, so dropping is the only
  // option and is safe. This is the ONLY safe drop (invariant 3).
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return { kind: 'drop' };
  const requestId = obj.requestId;

  if (reviewNack) return { kind: 'refuse', requestId, error: 'review-mode' };
  if (!ready) return { kind: 'refuse', requestId, error: 'block is not ready' };
  if (!signedIn) return { kind: 'refuse', requestId, error: 'sign in to post' };
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) {
    return { kind: 'refuse', requestId, error: 'no images to post' };
  }

  const request: CreatePostGateDecision & { kind: 'proceed' } = {
    kind: 'proceed',
    request: { requestId, sources: obj.sources },
  };
  if (typeof obj.title === 'string') request.request.title = obj.title;
  if (typeof obj.detail === 'string') request.request.detail = obj.detail;
  if (Array.isArray(obj.tags)) {
    request.request.tags = obj.tags.filter((t): t is string => typeof t === 'string');
  }
  if (typeof obj.modelVersionId === 'number' && Number.isInteger(obj.modelVersionId)) {
    request.request.modelVersionId = obj.modelVersionId;
  }
  return request;
}

export type CreatePostConsentCopy = {
  title: string;
  /** The leading sentence. Everything else the dialog shows is structured. */
  intro: string;
  /** The destination, in plain words. Always rendered. */
  destination: string;
  /** Present only when a gallery attach was requested. */
  galleryLine: string | null;
  /** Present only when some requested tags will be silently dropped. */
  droppedTagsLine: string | null;
  confirmLabel: string;
};

/**
 * The copy for the host-chrome consent confirm.
 *
 * 🔴 THE SENTENCES MUST NAME THE CONSEQUENCES THE VIEWER CANNOT SEE FROM THE
 * THUMBNAILS. Two of them are invisible in a picture and both are irreversible in
 * practice:
 *   - the post is PUBLIC and carries the VIEWER'S name (not the app's);
 *   - a gallery attach puts it on SOMEONE ELSE'S model page.
 * A dialog that shows four thumbnails and says "Publish?" has told the viewer
 * nothing about either.
 *
 * The block-influenced inputs are `appName` (PUBLISHER-controlled) and
 * `preview.droppedTags` (the block's own unresolved tag strings, echoed back).
 * BOTH are run through `sanitizeAppChromeName` (strips `\p{Cf}` bidi overrides
 * and zero-width padding, maps `\p{Cc}` to spaces, bounds zalgo and length) —
 * the same anti-spoof the follow gate applies and the publish confirm does not.
 * A dropped name that sanitizes to nothing is omitted rather than rendered as an
 * empty entry, and if that empties the set the line is not shown at all.
 *
 * ⚠️ `title`/`detail`/`tags`/`images`/`gallery` come from the SERVER'S preview,
 * never from the wire. Passing the raw block payload here would silently turn the
 * consent screen back into a ceremony, which is why this function takes a
 * `CreatePostPreview` and not the request.
 */
export function buildCreatePostConsentCopy({
  appName,
  preview,
}: {
  appName?: string | null;
  preview: CreatePostPreview;
}): CreatePostConsentCopy {
  const who = sanitizeAppChromeName(appName) ?? 'This app';
  const n = preview.images.length;
  const noun = `${n} image${n === 1 ? '' : 's'}`;
  const droppedTags = preview.droppedTags
    .map((t) => sanitizeAppChromeName(t))
    .filter((t): t is string => t !== null);
  return {
    title: 'Publish this post to your profile?',
    intro: `${who} wants to publish ${noun} as a post on your Civitai profile.`,
    // Named explicitly rather than implied by the dialog title: the viewer's
    // BYLINE is the consequence that distinguishes this from the app's own grid.
    destination:
      'The post will be public, will appear in your profile under your name, and can be deleted from your posts at any time.',
    galleryLine: preview.gallery
      ? `It will also appear in the gallery for ${preview.gallery.modelName} — ${preview.gallery.versionName}.`
      : null,
    droppedTagsLine:
      droppedTags.length > 0
        ? `These requested tags do not exist and will not be added: ${droppedTags.join(', ')}.`
        : null,
    confirmLabel: 'Publish post',
  };
}
