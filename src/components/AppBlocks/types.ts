/**
 * App Blocks — type definitions shared between the host (this app) and the
 * registry payload returned by `blocks.listForModel`. See
 * docs/features/app-blocks.md for the architecture overview.
 */

/**
 * The host's own PRODUCER-facing slot context shape — the loose supertype every
 * concrete context extends. The index signature is deliberate and load-bearing:
 * `projectBlockInitContext` writes allowlisted keys onto a fresh `SlotContext`
 * by computed key, and several host call sites hand a partially-built context
 * around before it is narrowed. Do NOT tighten it into a union here.
 *
 * The DISCRIMINATED UNION of what the host can actually produce is
 * `BlockSlotContext` (= ModelSlotContext | PageContext) below — that is the type
 * to reach for when you need to know WHICH slot you are holding. The SDK now
 * mirrors `BlockSlotContext` as a real union on the block side, so a block gets
 * exhaustiveness checking on `entityType` that this index-signature type cannot
 * give it.
 */
export interface SlotContext {
  slotId: string;
  [key: string]: unknown;
}

/**
 * Snapshot of the effective Checkpoint the block will generate against —
 * already merged from publisher default + viewer override on the host.
 * For Checkpoint-bound installs this is the model itself; for LoRA installs
 * it's whichever Checkpoint the resolver picked.
 *
 * `null` means no checkpoint is configured (rare in practice — install
 * forms enforce the publisher default at write time). Blocks should render
 * a "missing checkpoint" state in that case.
 */
export interface BlockCheckpointInfo {
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
}

/**
 * One of the model version's curated preview images, with the standard
 * gen params extracted from its meta. Block UIs use these to let the user
 * "remix" a known-good prompt without typing it themselves.
 *
 * `null` on a gen-param field means the source image's meta didn't have
 * that value (or it was malformed) — the block should treat null as "keep
 * the current value" rather than clearing the field.
 */
export interface ShowcaseImage {
  id: number;
  url: string;
  width: number;
  height: number;
  prompt: string | null;
  negativePrompt: string | null;
  cfgScale: number | null;
  steps: number | null;
  seed: number | null;
  sampler: string | null;
  /** Per-resource CLIP layer skip count (SD1/SDXL). Flux ignores it. */
  clipSkip: number | null;
}

/**
 * The entity a slot's context binds to. Drives the entity-aware token mint +
 * binding. Only `model` (the three model slots) and `none` (the W10 page) are
 * used today; `user`/`image` are reserved (Phase 1/2) and intentionally not
 * given a context type yet.
 */
export type SlotEntityType = 'model' | 'none';

export interface ModelSlotContext extends SlotContext {
  slotId: 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';
  /** Discriminator — present for the entity-aware mint/binding. */
  entityType?: 'model';
  modelId: number;
  modelVersionId: number;
  modelName: string;
  modelType: string;
  modelNsfwLevel: number;
  creatorUserId: number;
  viewerUserId: number | null;
  viewerNsfwEnabled: boolean;
  viewerUsername?: string | null;
  /**
   * Host-internal viewer moderation state. Intentionally NOT forwarded to the
   * iframe (see projectBlockInitViewer) — exposing ban/mute to untrusted
   * publisher code is a privacy leak with no consumer.
   */
  viewerStatus?: 'active' | 'banned' | 'muted';
  /** Host-page color scheme — lets the iframe match without a flicker. */
  theme?: 'light' | 'dark';
  /**
   * Effective Checkpoint after publisher-default ∪ viewer-override merge.
   * `null` when no checkpoint is configured AND the bound model isn't one
   * itself (misconfigured install).
   */
  checkpoint?: BlockCheckpointInfo | null;
  /**
   * Top showcase images for this model version, ordered by all-time
   * reactions. Capped at 6 by the host. Empty array means the version
   * has no preview images yet.
   */
  showcaseImages?: ShowcaseImage[];
}

/**
 * W10 full-page app context (entity=none). A page is PURE viewer-scoped: no
 * model/user/image entity, no money scopes. It carries only the viewer +
 * routing info the block needs to render a full page and deep-link. The host
 * mints the token from a synthetic `page_<appBlockId>` resolved directly from
 * the approved AppBlock — there is no install row (stateless, Decision 2).
 */
export interface PageContext extends SlotContext {
  slotId: 'app.page';
  entityType: 'none';
  /** The block_id slug the page route resolved (`<slug>.civit.ai`). */
  slug: string;
  /** Sub-path under the page route (`/apps/run/<slug>/<...path>`), no leading
   *  slash. Empty string for the page root. Forwarded so the block can deep-link. */
  subPath: string;
  /**
   * @deprecated Same unconditional identity disclosure as
   * `BlockInitPayload.viewer.id`, through a SECOND, currently-UNPROJECTED
   * channel. `GET_VIEWER` / `blocks.getMyViewer` is the replacement.
   *
   * 🔴 READ THIS BEFORE BELIEVING THE `viewer.id` DEPRECATION BUYS ANYTHING ON
   * THIS SURFACE. `IframeHost` runs its slot context through
   * `projectBlockInitContext`, whose allowlist DROPS `viewerUserId` /
   * `viewerUsername` — so on the model slot the `viewer` object is the only
   * identity channel and deprecating it is the whole story. `PageBlockHost` does
   * NOT project: `buildContext()` emits this field verbatim into
   * `BLOCK_INIT.context`, so a full-page block still learns exactly who is
   * looking at it whether or not it reads `viewer.id`. Deprecating `viewer.id` /
   * `viewer.username` therefore reduces disclosure on the model slot and by
   * ZERO on the page.
   *
   * Deliberately still sent, and NOT removed in the PR that added this note.
   * These are published SDK contract fields on `PageContext` — a block author was
   * told to read them — and the removal is only safe behind the same kind of
   * deployed-population enumeration that backed the `blockId` / `appId` /
   * `viewer.id` findings. That enumeration covered the `viewer` object; it was
   * NOT run for `context.viewerUserId`. Removing these on the strength of the
   * `viewer.id` result would be generalising one measurement onto a different
   * field. The honest state is: known over-share, un-enumerated, un-removed.
   *
   * Removing it is a page-context projection (a page-shaped allowlist —
   * `projectBlockInitContext`'s model allowlist would strip `slug` / `subPath` /
   * `entityType` and break deep-linking, so it is NOT a drop-in), gated on that
   * enumeration. `PageBlockHostInitContractV2.browser.test.tsx` pins the field as
   * PRESENT today, so that removal has to be a deliberate act with the
   * enumeration in hand rather than a silent one.
   */
  viewerUserId: number | null;
  /** @deprecated Same second-channel disclosure as `viewerUserId` above — read
   *  that note before assuming the `viewer.username` deprecation covers it. */
  viewerUsername?: string | null;
  /** Host-page color scheme — lets the iframe match without a flicker. */
  theme?: 'light' | 'dark';
}

/**
 * The union of slot contexts the host can produce. Discriminated by
 * `entityType` (with the model case allowed to omit it for back-compat — model
 * producers predate the discriminator). `none` is the page.
 */
export type BlockSlotContext = ModelSlotContext | PageContext;

/**
 * Entity-agnostic remount key for a BlockSlot mount. Replaces the model-only
 * `${slotId}:${context.modelId}` key. PRESERVES the exact model remount-on-nav
 * behavior (H-4): for a model context the entity id is the modelId, so the key
 * is `${slotId}:model:${modelId}` and still force-unmounts on model navigation.
 * For a page it keys on the slug (`${slotId}:none:<slug>`).
 */
export function slotRemountKey(args: {
  slotId: string;
  entityType: SlotEntityType;
  entityId?: string | number | null;
}): string {
  const { slotId, entityType, entityId } = args;
  return `${slotId}:${entityType}:${entityId ?? 'none'}`;
}

/**
 * SDK BLOCK_INIT contract — the payload the host posts to the iframe once
 * iframe.load AND token are both ready. Matches @civitai/app-sdk/blocks v1.
 * See docs/features/app-blocks.md "BLOCK_INIT contract".
 *
 * ── THE DEPLOYED POPULATION, AND WHICH NUMBER MEANS WHAT ─────────────────────
 * Several `@deprecated` notes below rest on an enumeration of deployed block
 * bundles. Three different counts are in play and they are NOT interchangeable;
 * quote the one that matches the claim you are making:
 *
 *   21 rows / 20 deployments — the `app_blocks` table. This is the population a
 *     COMPATIBILITY claim must cover ("removing field X breaks nobody"), because
 *     a suspended block is not gone: `relistListing` in
 *     src/server/services/blocks/offsite-moderation.service.ts flips
 *     `app_blocks.status` suspended → approved in the same tx as the relist, and
 *     the bundle starts serving again unchanged. A field removed while a block
 *     is suspended breaks it the moment it is restored.
 *
 *   9 approved — the APPROVED set: a CEILING on what is served today, and all a
 *     "what happens today" claim covers. Both serving surfaces gate on
 *     `status: 'approved'` — `BlockRegistry.resolvePageBlockBySlug` for the
 *     page, and for the model slot the slot-resolution SQL in
 *     `BlockRegistry.listForModel`
 *     (src/server/services/block-registry.service.ts, the four source-rank
 *     branches around lines 803 / 864 / 942 / 1016) — so a suspended block
 *     receives no BLOCK_INIT at all right now.
 *
 *     🔴 NOT the `known-app-blocks` query, which an earlier draft of this note
 *     cited for the model slot. That module
 *     (src/server/services/blocks/known-app-blocks.service.ts) is a 5-minute TTL
 *     cache whose stated job is to BOUND the `app_block_id` Prometheus label on
 *     the public /api/track/block-render beacon. It gates a metric label, not
 *     serving, and nothing in the render path consults it.
 *
 *     🔴 AND "9 approved" OVERSTATES what actually receives a BLOCK_INIT.
 *     `approved` is necessary, not sufficient. Each of those four model-slot
 *     branches ANDs a DEPLOY GATE on top of it —
 *     `(ab.external_url IS NOT NULL OR ab.current_version_deployed_at IS NOT
 *     NULL)` — and additionally needs a row that puts the block on the slot (a
 *     `block_user_subscriptions` row or a `platform_default_blocks` row) plus a
 *     manifest slot match. The page surface likewise adds
 *     `manifestDeclaresPage(manifest)`. So the actually-serving set on either
 *     surface is a strict-or-equal SUBSET of the 9, and its size was NOT
 *     enumerated here. Read "9 approved" as an upper bound, never as a count of
 *     what renders.
 *
 *   what was EXECUTED — the `isValidBlockInitPayload` guard was extracted and
 *     RUN against synthetic payloads for the 9 approved bundles; the runtime
 *     field-reader survey ("5 of 9 read `viewer.id`") is over those same 9. The
 *     remaining deployments were NOT guard-executed. So the removal-is-an-outage
 *     conclusion is measured on the 9 and INFERRED for the other 11 — which is
 *     the safe direction (they ship the same SDK guard), but it is an inference
 *     and is written as one.
 *
 * Where a note below says "the 9 approved" it means the executed set; where it
 * says "the deployed population" it means all 20 deployments / 21 rows.
 */
export interface BlockInitPayload {
  blockInstanceId: string;
  /**
   * @deprecated BUILD-TIME identity. A block already knows its own `blockId` —
   * it is baked into the bundle the publisher shipped — so the host telling it
   * again carries no information. The reader survey over the 9 approved bundles
   * found ZERO runtime readers: nothing reads this field after init.
   *
   * 🔴 DEPRECATED, NOT REMOVABLE — dropping it from the wire is a FLEET-WIDE
   * OUTAGE. Every already-deployed bundle carries a compiled-in
   * `isValidBlockInitPayload` guard that REJECTS the whole BLOCK_INIT payload
   * when `blockId` is absent. We fetched that guard from each of the 9 approved
   * bundles and EXECUTED it: a payload without this field fails validation on
   * every one, the block never initialises, and the viewer sees a blank block.
   * The other 11 deployments were not executed against — same SDK guard, so the
   * conclusion is inferred there, not measured (see the population note above).
   * It must keep being sent until every DEPLOYED bundle — all 20, not just the 9
   * serving today, since a suspension is reversible — has been rebuilt against a
   * v2 guard, which the platform cannot force because publishers own their own
   * release cadence.
   */
  blockId: string;
  /**
   * @deprecated BUILD-TIME identity, exactly like `blockId` above: the OAuth
   * client id is baked into the bundle, and the reader survey over the 9
   * approved bundles found ZERO readers of this field.
   *
   * 🔴 DEPRECATED, NOT REMOVABLE — same fleet-wide-outage mechanism: the
   * `isValidBlockInitPayload` guard compiled into every already-deployed bundle
   * rejects a BLOCK_INIT payload that is missing `appId`, so removing it from
   * the wire blanks every live block at once.
   */
  appId: string;
  /** Wrapped token + metadata so blocks don't have to JWT-decode. */
  token: {
    raw: string;
    scopes: string[];
    expiresAt: string;
    /** Present only when manifest declares ai:write:budgeted. */
    buzzBudget?: number;
  };
  context: SlotContext;
  /** Empty `userSettings` in v1 — Phase 2 wires per-viewer prefs. */
  settings: {
    publisherSettings: Record<string, unknown>;
    userSettings: Record<string, unknown>;
  };
  /**
   * Whether a signed-in viewer is present, and (deprecated) who they are.
   *
   * `null` = anonymous. An OBJECT = signed in.
   *
   * 🔴 THE WIRE SHAPE IS FROZEN AT `object-or-null`. The
   * `isValidBlockInitPayload` guard compiled into every already-deployed bundle
   * accepts only `null` or an object carrying a NUMERIC `id`; anything else
   * (a boolean, a string, an object without `id`) fails validation and the block
   * never initialises. So this cannot be collapsed to a bare `signedIn: boolean`
   * on the payload root, however much tidier that would read.
   */
  viewer: {
    /**
     * @deprecated Identity disclosed to the block UNCONDITIONALLY, at load,
     * before the viewer has interacted with it at all — every block that renders
     * learns who is looking at it whether or not it ever needed to know, and
     * nothing records that it happened. The replacement is `GET_VIEWER`
     * (host-mediated `blocks.getMyViewer`), which requires the block to ASK: a
     * server round-trip that verifies the token, requires the block to have
     * DECLARED and been GRANTED the `user:read:self` scope, self-binds the id off
     * the token subject, and is rate-limited per block instance. (It does not
     * write an audit row — an earlier draft of this note said it did. The gain is
     * the consent scope and the round-trip, not a persisted trail.)
     *
     * Still sent because the deployed guard requires the object shape (see the
     * `viewer` doc above) AND because 5 of the 9 currently-approved apps read
     * `viewer.id` at runtime for load-bearing logic — ownership filters and
     * optimistic row authorship. Removing it silently breaks those five.
     *
     * 🔴 SCOPE OF WHAT THIS DEPRECATION ACTUALLY BUYS — it is NOT the whole
     * identity story, and this note exists so nobody reads it as one. THREE
     * channels in a BLOCK_INIT carry viewer identity; this deprecation covers
     * one of them:
     *
     *   - MODEL SLOT (`IframeHost`): `projectBlockInitContext`'s allowlist
     *     already drops `viewerUserId` / `viewerUsername` from
     *     `BLOCK_INIT.context`, so on this surface the `viewer` object is the
     *     only identity channel IN THE CONTEXT. It is NOT the only one in the
     *     PAYLOAD — see the token below.
     *   - FULL PAGE (`PageBlockHost`): it buys NOTHING today. That host does not
     *     project its context — `buildContext()` emits `viewerUserId` and
     *     `viewerUsername` into `BLOCK_INIT.context` verbatim, an undeprecated
     *     second channel carrying the same identity. See the `@deprecated` notes
     *     on `PageContext.viewerUserId` for why they were not removed here
     *     (published SDK contract fields; the deployed-population enumeration
     *     that backs this file's other claims was never run for them).
     *   - BOTH SURFACES — `token.raw`. The block token is a plain RS256 JWT, not
     *     an opaque handle: its payload is base64url and its `sub` claim is
     *     `user:<id>` for a signed-in viewer (`block-token.service.ts` builds it,
     *     and docs/features/app-blocks.md "Tokens" states the claim). Every
     *     BLOCK_INIT ships it — IframeHost's and PageBlockHost's
     *     `buildInitPayload` both set `token.raw` — so any block can read the
     *     viewer's numeric id by decoding a string it was handed, with no scope
     *     check, no round-trip, and nothing server-side able to observe that it
     *     happened. This channel is UNDEPRECATED and is not a defect to be
     *     closed: it is the auth mechanism, and the block needs the token.
     *
     * So retiring `viewer.id` / `viewer.username` does NOT end unconditional
     * identity disclosure on either surface — including the model slot. Stated
     * at the scope it actually holds, what it buys is:
     *
     *   1. the USERNAME leaves the unconditional payload on the model slot (the
     *      token's `sub` carries the numeric id only); and
     *   2. the numeric id stops being a convenient, typed, obviously-intended
     *      field read and becomes a deliberate JWT decode.
     *
     * Both are real narrowings of the CONVENIENT channel. Neither is an end to
     * disclosure. The token channel is co-extensive with this object in WHEN it
     * discloses — `sub` is `anon` for an anonymous viewer, exactly when `viewer`
     * is `null` — so a signed-in viewer's id reaches the block either way.
     * Ending disclosure would take a token-subject change (an opaque,
     * per-instance pairwise subject), which is a token-design decision, not a
     * payload-field one, and is not part of this PR.
     */
    id: number;
    /**
     * @deprecated Same unconditional-disclosure problem as `id`: the username is
     * handed to every block on load with no interaction and no audit trail. Use
     * `GET_VIEWER` / `blocks.getMyViewer` instead. Still sent for the deployed
     * bundles that read it.
     */
    username: string | null;
    /**
     * The forward-looking MINIMAL signal, and the only viewer field a v2 block
     * should read: "is someone signed in?" — which is all the overwhelming
     * majority of blocks actually branch on (render a sign-in prompt vs the app).
     * Literally `true` when present; the field is ABSENT on an anonymous viewer
     * because an anonymous viewer has no `viewer` object at all.
     *
     * OPTIONAL, and it must stay optional: `BlockInitPayload` is also the shape
     * of BLOCK_INIT payloads constructed by older host code paths and by test
     * fixtures, so a REQUIRED field here would break them at compile time for no
     * wire benefit. On the wire it is an ADDED key, not a removed or reshaped
     * one — so it cannot trip the deployed-guard failures documented above,
     * which are all "required field missing / wrong shape". (Worth re-checking
     * against a live bundle before the first v2 rollout if the guard ever turns
     * out to reject unknown keys; nothing in the enumeration suggested it does.)
     */
    signedIn?: true;
  } | null;
  theme: 'light' | 'dark';
  renderMode: 'iframe' | 'inline';
  /**
   * Color-domain maturity signal (ADVISORY — for block self-filtering / blur).
   * The AUTHORITATIVE enforcement is the server-side generation clamp keyed on
   * the same value baked into the block token's `maxBrowsingLevel` claim; this
   * field lets a block proactively filter its own catalog reads and blur mature
   * thumbnails without a round-trip.
   *
   * - `domain`: the color domain the token was minted on (`green`|`blue`|`red`),
   *   or null when the host didn't resolve to a known color.
   * - `maxBrowsingLevel`: the bitwise browsing-level ceiling for this domain
   *   (green/blue → SFW, red → all). Consumed by the SDK `useDomainMaturity()`
   *   hook (separate follow-up PR in the SDK repo).
   */
  domain?: 'green' | 'blue' | 'red' | null;
  maxBrowsingLevel?: number;
}

export interface BlockManifest {
  iframe?: {
    src: string;
    minHeight: number;
    maxHeight: number | null;
    resizable: boolean;
    sandbox: string;
  };
  scopes?: string[];
  contentRating?: string;
  name?: string;
  renderMode?: 'iframe' | 'inline' | 'hybrid';
  [key: string]: unknown;
}

export interface BlockInstall {
  blockInstanceId: string;
  blockId: string;
  appId: string;
  /**
   * `app_blocks.id` for this install — distinct from `blockId` (the
   * manifest's block id) and `appId` (the OauthClient id). Required
   * for App Blocks buzz attribution: the publisher revenue-share row
   * stamps the specific app_block row that earned the share.
   */
  appBlockId: string;
  manifest: BlockManifest;
  publisherSettings: Record<string, unknown>;
  enabled: boolean;
  renderMode: 'iframe' | 'inline';
  trustTier: 'unverified' | 'verified' | 'internal';
}
