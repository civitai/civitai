/**
 * "Published with <app>" CHIP projection for the post DETAIL page.
 *
 * A post created by an App Block carries `Post.metadata.blockPublishedAppId` —
 * the publishing app's `OauthClient.id`. Nothing on the way to the screen read
 * it, so a viewer could not tell an app-published post from a hand-made one.
 * This module is the whole server-side decision, and it is deliberately pure +
 * I/O-INJECTED so every branch is assertable in the node `unit` project without
 * a database and without booting the post page's module graph. Same extraction
 * precedent as `resolveLegacyAppRedirect.ts` / `resolveAppsPageAccess.ts`.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 🔴 THREE CONSTRAINTS. EACH ONE IS THE REASON A LINE BELOW LOOKS INDIRECT.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * ## 1. `Post.metadata` MUST NOT REACH THE CLIENT. The marker is read SEPARATELY.
 *
 * `getPostDetail` ends `return { ...post, ... }` — it spreads its selection
 * wholesale to the client — and Prisma cannot select a JSON SUBKEY, so
 * `metadata: true` on `postSelect` is the only way to get the marker through
 * that projection. It would ship EVERY `Post.metadata` key to a public,
 * anon-capable read. Measured key counts on the live table at the time of
 * writing: `imageNsfwLevel` 160,158 · `imageNsfw` 33,919 · `unpublishedBy`
 * 1,251 · `unpublishedAt` 1,251 · `reviewId` 1,132 · `prevPublishedAt` 995.
 * Two of those are moderator ids and a moderation-review id.
 *
 * It would also DEFEAT A CONTROL THAT ALREADY EXISTS: `getPostDetail`
 * deliberately computes `PostUnpublishContext` and forces `unpublishedBy: null`
 * for a published post. Widening the select would route the same moderator id to
 * the client by a second path that nothing guards.
 *
 * So the marker is fetched by its own narrow read (`postAppMarkerQuery`), the
 * JSON blob never leaves this module, and exactly ONE derived field — a
 * {@link PostAppChip} or `null` — is returned. `postSelect` is unchanged, and
 * `post-app-chip.projection.test.ts` fails if it ever gains `metadata`.
 *
 * ## 2. `OauthClient` HOLDS A CLIENT SECRET. The app read is an ALLOWLIST.
 *
 * `OauthClient` carries `secret`, `redirectUris` and `allowedOrigins` alongside
 * `name`. This chip is rendered on an anon-capable public read, so a careless
 * projection is a credential leak. Both halves are pinned: the SELECT names only
 * allowlisted columns ({@link postAppChipQuery}) and the PROJECTOR emits only the
 * three fields of {@link PostAppChip} ({@link projectPostAppChip}). Same posture
 * as `public-owner.ts`: adding a field in either place is a deliberate act.
 *
 * 🔴 THE EXPECTED KEY LIST IS NOT EXPORTED FROM HERE, DELIBERATELY. It is written
 * out as a literal in the test — `EXPECTED_CHIP_KEYS` in
 * `__tests__/post-app-chip.projection.test.ts` — so the assertion is a SECOND,
 * INDEPENDENT statement of the shape. A constant exported from this module and
 * asserted against would be self-referencing: a widening that edited the
 * projector and the constant together would pass. (An earlier revision did export
 * one, which is why this is spelled out rather than left implicit.)
 *
 * ## 3. RESOLVE-OR-OMIT. A marker that resolves to NOTHING is REACHABLE BY DESIGN.
 *
 * The `appblk-<slug>` mint form is a maintained invariant for the approved
 * publish path, but it is NOT the only writer. The dev-scoped mint path
 * (`dev-scoped-mint.service.ts`) carries `posts:write:self` and mints a
 * deliberately SYNTHETIC, non-resolving appId — its own header says "never an
 * `appblk-<slug>` OauthClient id nor a UUIDv4" — precisely so the spend
 * attribution lookup misses. So a post whose marker matches no `OauthClient` is
 * a normal state, not corruption.
 *
 * Consequence: the app is always LOOKED UP, never string-munged out of the
 * marker, and there are FOUR outcomes, not two:
 *
 *   a. marker resolves to no `OauthClient`  → NO CHIP (`null`).
 *   b. resolves, refused on LIFECYCLE       → chip with `slug: null` (name
 *      rendered UNLINKED). Draft, pending, rejected, delisted, suspended, or
 *      never-deployed: the app exists, the store just has no page for it.
 *   c. resolves and is publicly viewable    → chip with a `slug` (name linked).
 *   d. resolves, refused on MATURITY        → NO CHIP (`null`), the client-name
 *      fallback included. On a non-red host the store hides a mature listing
 *      outright, so the faithful mirror is silence rather than an unlinked
 *      title. See {@link projectPostAppChip} — this one is easy to collapse into
 *      (b) by accident, and doing so leaked an app's store title.
 *
 * ## The viewability predicate, and the link target
 *
 * VIEWABLE is FOUR terms, and the last two are the destination's own gates —
 * `postAppChipQuery` documents why each is selected, and `readListingCandidate`
 * why they are grouped as lifecycle-vs-maturity rather than one conjunction:
 *
 *   `app_listings.status = 'approved'` AND `app_blocks.status = 'approved'`
 *   AND (the listing is not `onsite` OR its block has deployed at least once)
 *   AND the rating is allowed on the request host.
 *
 * The join is `OauthClient.id → app_blocks.app_id → app_listings.app_block_id`.
 * All three tables are in the MAIN database (`AppBlock` is an ordinary Prisma
 * model, `@@map("app_blocks")`), so this is one same-DB read and NOT a
 * cross-database query on a public page load. `requireAppsDb()` is an unrelated
 * mechanism (the per-app storage schemas) and is deliberately not involved.
 *
 * The link target is `/apps/store-preview/<AppListing.slug>`, built by the
 * CALLER from the chip's `slug`. It is NOT `/apps/<marker>`: that legacy route
 * is retired (it 302s away — see `resolveLegacyAppRedirect.ts`) and its param is
 * an `AppBlock.id` (`apb_<ULID>`), a different identifier from the marker.
 *
 * ## The icon is the LISTING's, not the OauthClient's
 *
 * `OauthClient.logoUrl` is dead weight — NULL for every `appblk-%` client
 * measured. The real app icon is `app_listings.icon_id → Image.url`, projected
 * through the shared `listingIconUrl` so the chip's icon is byte-identical to
 * the one the store renders for the same app. A live app has no icon at all, so
 * `iconUrl: null` is an ordinary case the UI must render gracefully.
 *
 * ## ⚠ THE WORDING TRAP, recorded because it already shipped once
 *
 * `public-owner.ts` exists *because* the app page rendered `by {appName}` and,
 * since an approved block's `OauthClient.name` equals the app's own title, the
 * AUTHOR slot showed the APP TITLE. The author is a person. This chip reads
 * "Published with X", never "by X" — pinned as a whole normalised string by the
 * component test so a reword cannot reintroduce it.
 *
 * ## 🔴 DO NOT PUT THIS ON A FEED / CARD SURFACE WITHOUT RESHAPING IT FIRST
 *
 * One of the most important properties of this module is what it does NOT touch:
 * `publishedWithApp` is added to `post.get`'s return ONLY — not to `postSelect`,
 * not to `getInfiniteImages` / `getAllImages`, not to `/api/v1/images`. Every
 * cost note here is priced PER PAGE. Surface the chip on a card in a list and all
 * of it becomes PER ROW, multiplied by the page size: the marker read would have
 * to become a batched `IN (…)` and the app row a `createCachedObject` by id array
 * BEFORE that is viable. Say so wherever the chip's reuse is next proposed.
 */
import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { BLOCK_POST_APP_ID_META_KEY } from '~/server/services/blocks/block-post.logic';
import { listingIconUrl } from '~/server/services/blocks/listing-media-url';
import { ratingAllowedOnHost } from '~/server/utils/server-domain';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import { scopeAdmitsListingKind } from '~/shared/utils/store-visibility-scope';

/**
 * The ONE shape that reaches the client.
 *
 * 🔒 EXPLICIT ALLOWLIST — see constraint 2 above. `slug` is the store-detail
 * slug when the app is publicly viewable and `null` when it is not (the UI then
 * renders the name unlinked); `iconUrl` is `null` when the listing has no icon.
 * Nothing from `OauthClient` other than `name` is ever copied here.
 */
export type PostAppChip = {
  slug: string | null;
  name: string;
  iconUrl: string | null;
};

/**
 * Which branch one resolution took.
 *
 * 🔴 IT EXISTS BECAUSE FOUR OF THESE FIVE BRANCHES PUT THE SAME `null` ON THE
 * WIRE. The feature fails open — decoration must never take a post page down —
 * so a dropped replica, a renamed column or a Prisma client that cannot see the
 * relation all return exactly what an ordinary hand-made post returns. Without a
 * discriminator the chip could stop existing site-wide with no signal anywhere.
 * `~/server/prom/post-app-chip.metrics.ts` is the counter; the union is declared
 * HERE, beside the decision, so the label domain cannot drift from the branches.
 *
 * `degraded` is not produced by {@link resolvePostAppChip} — only the I/O wiring
 * can know a read threw — which is why {@link PostAppChipResolution} excludes it.
 */
export type PostAppChipOutcome = 'chip' | 'no-marker' | 'unresolved' | 'gated' | 'degraded';

/** One resolution: the chip (or `null`) plus the branch that produced it. */
export type PostAppChipResolution = {
  chip: PostAppChip | null;
  outcome: Exclude<PostAppChipOutcome, 'degraded'>;
};

/**
 * The status both `app_listings` and `app_blocks` must hold to be publicly
 * viewable.
 *
 * 🔴 VIEWABILITY IS SPELLED AS `=== APPROVED_STATUS`, NEVER AS "not delisted".
 * Both columns default to a NON-approved value (`app_listings.status` defaults
 * to `draft` over the domain `draft|pending|approved|rejected|removed`;
 * `app_blocks.status` defaults to `pending`), so a denylist — `!== 'removed'`,
 * `!== 'suspended'` — admits the DEFAULT STATE of both tables and would put a
 * draft listing's slug and icon on a public post page. The allowlist is the only
 * spelling that fails closed. `post-app-chip.projection.test.ts` iterates the
 * whole status domain rather than sampling one rejected value, because a fixture
 * that only ever uses `removed`/`suspended` cannot tell the two spellings apart —
 * three such denylist rewrites survived a fully green suite before it did.
 */
export const APPROVED_STATUS = 'approved';

/**
 * The narrow marker read.
 *
 * 🔴 A SEPARATE QUERY IS THE POINT, not an oversight — see constraint 1. The
 * JSON blob this returns is consumed by {@link readBlockPublishedAppId} inside
 * this module and never returned to a caller.
 *
 * No visibility filter: the only caller resolves this AFTER `getPostDetail` has
 * already authorised the post for this viewer, so re-deriving the authorisation
 * here would be a second, divergeable copy of it.
 */
export function postAppMarkerQuery(postId: number) {
  return { where: { id: postId }, select: { metadata: true } };
}

/**
 * Pull the marker out of a raw `Post.metadata` value, or `null`.
 *
 * Defensive about types on purpose: `metadata` is a Prisma `Json` column, so at
 * runtime it is `unknown`-shaped — it can be `null`, a scalar, an array, or an
 * object whose marker is any JSON type. A blank / whitespace-only marker is
 * treated as absent: it is not addressable and must not trigger a lookup.
 */
export function readBlockPublishedAppId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  // 🔴 The key comes from the WRITER's own constant, never a re-spelled literal —
  // see its declaration in `block-post.logic.ts`. An `Array.isArray` guard used
  // to sit above this and was removed as dead: indexing an array with a string
  // key yields `undefined`, which the `typeof` check below already rejects, so
  // the branch could not be reached and a test over it could not fail.
  const raw = (metadata as Record<string, unknown>)[BLOCK_POST_APP_ID_META_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The app read's Prisma args.
 *
 * 🔴 BUILT HERE RATHER THAN INLINE AT THE CALL SITE so the ALLOWLIST is pinned
 * by a test. This select is one of the two things standing between an OAuth
 * client secret and a public post page (the other is
 * {@link projectPostAppChip}), and a widening edit here is a one-word change
 * that no behavioural test over the projector can see.
 *
 * `appBlocks` is a LIST because one `OauthClient` may own several blocks
 * (`@@unique([appId, blockId])`); the marker identifies the APP, not a block.
 * `appListing` is a to-one (`AppListing.appBlockId` is `@unique`). `revisionOfId`
 * is selected so the projector can reject a shadow revision rather than trusting
 * that a revision can never hold the unique `appBlockId` — defence in depth on a
 * public read, matching `approvedListingSlugQuery`.
 *
 * 🔴 EVERY OTHER COLUMN HERE IS A TERM OF THE VIEWABILITY PREDICATE, AND THE
 * PREDICATE HAS TO MATCH THE DESTINATION'S OR THE LINK IS A 404. The chip's link
 * goes to the store detail, whose own read (`getListingDetail` in
 * `app-listing.service.ts`) rejects a row on THREE grounds beyond the listing
 * status, and a chip that links a row that read refuses is exactly the "404
 * dressed as a working link" this feature was supposed to avoid:
 *
 *   - `status` on BOTH sides — the listing's, plus the block's, which is this
 *     chip's own additional requirement (strictly narrower than the store's, so
 *     it can only ever under-link);
 *   - `kind` + `currentVersionDeployedAt` — the DEPLOY gate. An `onsite` listing
 *     whose block has never successfully deployed has no origin to serve, so the
 *     store treats it as missing. `kind` is the discriminator because an
 *     `offsite` row has no deploy concept at all — and an `appBlockId` is NOT a
 *     kind discriminator (off-site backfilled rows carry one), so it must be
 *     read rather than assumed;
 *   - `contentRating` — the MATURITY gate, resolved against the request host by
 *     the shared `ratingAllowedOnHost`.
 *
 * Those three were "STILL OWED" at `approvedListingSlugQuery`, which is the
 * sibling precedent; they are closed here instead of inherited, because unlike
 * that resolver this one already has the host threaded to it.
 */
export function postAppChipQuery(appId: string) {
  return {
    where: { id: appId },
    select: {
      name: true,
      appBlocks: {
        select: {
          status: true,
          currentVersionDeployedAt: true,
          appListing: {
            select: {
              id: true,
              slug: true,
              name: true,
              status: true,
              kind: true,
              contentRating: true,
              revisionOfId: true,
              icon: { select: { url: true } },
            },
          },
        },
      },
    },
  };
}

/** The row shape {@link postAppChipQuery} produces. */
export type PostAppChipRow = {
  name?: unknown;
  appBlocks?: unknown;
};

type ListingCandidate = {
  slug: string;
  name: string;
  iconUrl: string | null;
  /** Every term passed: the chip may be LINKED. */
  viewable: boolean;
  /**
   * The MATURITY term specifically refused this candidate on this host.
   *
   * 🔴 TRACKED SEPARATELY FROM `viewable`, WHICH IS THE WHOLE FIX FOR A REAL LEAK.
   * Folded into one boolean, a maturity refusal was indistinguishable from a
   * lifecycle refusal — so it took the lifecycle branch, which withholds the slug
   * and the icon but KEEPS THE NAME, and a mature app's store title rendered on a
   * host where the store hides the card entirely. The two refusals differ in kind
   * and have to be answered differently; see {@link projectPostAppChip}.
   */
  maturityRefused: boolean;
};

/**
 * One `AppBlock` row → a candidate, or `null` when the block carries no store row
 * this chip could ever name.
 *
 * `host` is the REQUEST's host, and it is required: it is the only input to the
 * maturity term, and a default would silently decide it. An empty host fails
 * closed for a mature rating (`ratingAllowedOnHost`), which is the safe
 * direction.
 *
 * 🔴 Returning `null` and being REFUSED are different outcomes. `null` means the
 * block carries nothing nameable (no listing, a shadow revision, a blank slug) —
 * it contributes no candidate at all, and so it can never be "lost to maturity".
 * A refused candidate is a real store row this host may not acknowledge.
 */
function readListingCandidate(
  block: unknown,
  host: string,
  /**
   * Listing ids the per-listing VISIBILITY LEVEL hides from a general viewer.
   *
   * 🔴 THE FOURTH TERM OF THE DESTINATION'S PREDICATE, and without it this chip links a
   * page that 404s — the exact failure `postAppChipQuery`'s docblock says this module
   * exists to avoid. `getListingDetail` gained a level gate, so an owner setting
   * `private`/`moderators`/`testers` on an APPROVED listing makes the store drop it while
   * every public post made with that app still showed its name, icon and a working-looking
   * link.
   *
   * It is resolved for the `public` floor only — strictly narrower than any real viewer's
   * floor, so it can only ever UNDER-link, which is the direction this module's docblock
   * already accepts for the block-status term.
   *
   * An EMPTY set reproduces pre-feature behaviour exactly (and is what an unapplied
   * migration yields), so it is the right default — but it is a default about visibility,
   * so the one service call site passes it explicitly and a guard pins that.
   */
  hiddenListingIds: ReadonlySet<string>
): ListingCandidate | null {
  if (typeof block !== 'object' || block === null) return null;
  const b = block as Record<string, unknown>;
  const listing = b.appListing;
  if (typeof listing !== 'object' || listing === null) return null;
  const l = listing as Record<string, unknown>;
  // A shadow revision is a draft and cannot be the app's store row.
  if (l.revisionOfId != null) return null;
  const slug = typeof l.slug === 'string' ? l.slug.trim() : '';
  if (!slug) return null;
  const icon = l.icon;
  // 🔴 ALL FOUR TERMS, and every one an ALLOWLIST — see APPROVED_STATUS on why a
  // denylist admits both tables' default state, and postAppChipQuery on why the
  // last two exist at all (they are the destination's own gates; without them a
  // "viewable" chip can link a page that 404s).
  //
  // 🔴 SPLIT INTO TWO GROUPS, NOT ONE CONJUNCTION. The LIFECYCLE terms answer
  // "does the store have a page for this?"; the MATURITY term answers "may this
  // host acknowledge it at all?". They are computed independently — note the
  // maturity term is evaluated even when lifecycle already failed, so a draft
  // mature app is still recorded as maturity-refused and still disappears on a
  // non-red host, which is what that host's store does with it.
  const deployed = l.kind !== 'onsite' || b.currentVersionDeployedAt != null;
  // 🔴 THE LEVEL IS A LIFECYCLE TERM, so a hidden listing degrades to name-unlinked rather
  // than vanishing — the same treatment a `removed` listing gets, and it is what keeps the
  // chip from becoming a 404. Grouped here, not with maturity, because it answers "does the
  // store have a page for this?" and not "may this host acknowledge it?".
  // 🔴 DEFENSIVE ON THE SET ITSELF, because this runs on a PUBLIC POST PAGE. The parameter
  // is required by the type so it cannot be forgotten in review, but a JS caller that omits
  // it must degrade to pre-feature behaviour rather than throw — a chip is cosmetic and must
  // never be the reason a post 500s. Same posture as the `…ForRender` readers.
  const levelOk = typeof l.id !== 'string' || !hiddenListingIds?.has(l.id);
  const lifecycleOk =
    b.status === APPROVED_STATUS && l.status === APPROVED_STATUS && deployed && levelOk;
  const maturityOk = ratingAllowedOnHost(
    typeof l.contentRating === 'string' ? l.contentRating : null,
    host
  );
  return {
    slug,
    // Publisher-controlled — sanitized at the projection, see projectPostAppChip.
    name: typeof l.name === 'string' ? sanitizeAppChromeName(l.name) ?? '' : '',
    iconUrl: listingIconUrl(
      typeof icon === 'object' && icon !== null
        ? {
            url:
              typeof (icon as { url?: unknown }).url === 'string'
                ? (icon as { url: string }).url
                : null,
          }
        : null
    ),
    viewable: lifecycleOk && maturityOk,
    maturityRefused: !maturityOk,
  };
}

/**
 * Project a joined `OauthClient` row → the public chip, or `null` when there is
 * no resolvable app (branch (a): an unresolvable marker, a LEFT-JOIN miss, a
 * client with no usable name).
 *
 * 🔒 EXPLICIT ALLOWLIST. Only `slug`, `name` and `iconUrl` are ever written —
 * nothing else from `OauthClient` (`secret`, `redirectUris`, `allowedOrigins`,
 * `description`, …) can leak, because nothing else is ever copied. Adding a
 * field here is a deliberate act.
 *
 * Candidate selection is DETERMINISTIC rather than "whatever the database
 * returned first": candidates are sorted by slug and a VIEWABLE one always wins
 * over a non-viewable one. In practice an `appblk-<slug>` client owns exactly
 * one block, so this only decides a case that should not arise — but a chip that
 * changed which app it named between two identical reads would be worse than
 * either answer.
 *
 * NAME precedence is `AppListing.name` → `OauthClient.name`. The listing name is
 * the store-facing title and the one the viewer will see again if they follow
 * the link; the client name is the fallback for an app with no listing row at
 * all.
 *
 * 🔴 A LIFECYCLE-REFUSED APP GETS NEITHER A SLUG NOR AN ICON, AND THE ICON HALF
 * IS DELIBERATE RATHER THAN A SIDE EFFECT OF WRITING THE TERNARY TWICE.
 * Suppressing the slug is the stated requirement (render the name unlinked).
 * Suppressing the icon as well is this module's own decision: the app is a draft,
 * rejected, delisted, suspended or never-deployed, and in every one of those
 * states the store refuses to serve that listing's media. Publishing its icon
 * onto a public post page would route the asset around the gate that is
 * withholding the page. The NAME is kept because the viewer needs to know what
 * made the post — that is the whole feature — and the name is sanitised; the icon
 * carries no such need.
 *
 * 🔴 A MATURITY REFUSAL IS DIFFERENT IN KIND AND SUPPRESSES THE CHIP ENTIRELY.
 * This is the one case where the reasoning above does NOT extend to the name, and
 * getting that wrong was a real leak: a mature-rated app's store TITLE rendered on
 * a non-red host, because a maturity refusal took the lifecycle branch, which
 * keeps the name. A lifecycle-refused app EXISTS and the store merely has no page
 * for it; a mature app on a non-red host is hidden outright — `listingMatureFilter`
 * drops the card and `getListingDetail` returns null — so on that host the store
 * behaves as though the listing does not exist. The faithful mirror of "does not
 * exist" is SILENCE, not an unlinked title.
 *
 * Three things that fix had to get right, each pinned by a test:
 *
 *   - 🔴 **Nulling the candidate's own name is a NO-OP.** It falls through to
 *     `clientName`, and for an `appblk-` client `OauthClient.name` is the same
 *     string the listing carries — so the title would still render. The
 *     suppression has to return `null` for the whole chip, `clientName` included.
 *   - **It is PER-CANDIDATE, not global.** A maturity-refused sibling must not
 *     suppress a candidate that is fine, and a LIFECYCLE-refused sibling is still
 *     preferred over suppressing (it keeps its unlinked name). Only when every
 *     candidate is gone AND at least one was lost to maturity does the chip go.
 *   - **It must not reach the no-listing case.** A block with no `AppListing`
 *     contributes no candidate, so nothing was lost to maturity and the
 *     `clientName` fallback — the documented branch (b) — still applies. Same for
 *     a shadow revision, which is filtered out before any gate runs.
 *
 * 🔴 BOTH NAMES ARE PUBLISHER-CONTROLLED, so both go through
 * `sanitizeAppChromeName` HERE — on the server, at the one place that builds the
 * wire value — rather than at the render site. The post page would otherwise
 * render unbounded publisher text (bidi RLO overrides that reorder the sentence,
 * zero-width padding of the accessible name, stacked combining marks bleeding
 * over adjacent UI, unbounded length) inside the chrome of someone else's post.
 * Sanitising at the projection means no present or future consumer of this DTO
 * can forget to. A name with nothing legible left is treated as no name at all:
 * the chip is dropped rather than rendered as a bare "Published with".
 */
/** The empty hidden-set, frozen so no caller can mutate a shared default. */
const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();

/**
 * Every candidate listing id in a chip row, for the batched level read.
 *
 * Tolerant of shape by design: this module is handed an `unknown`-ish row and every other
 * reader here narrows defensively rather than trusting it.
 */
export function listingIdsInChipRow(row: PostAppChipRow | null): string[] {
  const blocks = Array.isArray(row?.appBlocks) ? row.appBlocks : [];
  const ids: string[] = [];
  for (const b of blocks) {
    const listing = (b as { appListing?: unknown } | null)?.appListing as
      | { id?: unknown }
      | null
      | undefined;
    if (listing && typeof listing.id === 'string') ids.push(listing.id);
  }
  return [...new Set(ids)];
}

export function projectPostAppChip(
  row: PostAppChipRow | null | undefined,
  /**
   * The REQUEST's host, for the maturity term. Required — it is the only input
   * that decides whether a mature app is viewable here, and a default would make
   * that decision silently. See {@link readListingCandidate}.
   */
  opts: {
    host: string;
    /** See {@link readListingCandidate}. Required so the level term cannot be forgotten. */
    hiddenListingIds: ReadonlySet<string>;
  }
): PostAppChip | null {
  if (!row) return null;
  const clientName = typeof row.name === 'string' ? sanitizeAppChromeName(row.name) ?? '' : '';
  const blocks = Array.isArray(row.appBlocks) ? row.appBlocks : [];
  const candidates = blocks
    .map((b) => readListingCandidate(b, opts.host, opts.hiddenListingIds))
    .filter((c): c is ListingCandidate => c !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // Preference order, and each fallback is a decision rather than a default:
  //   1. a fully VIEWABLE candidate            → the linked chip;
  //   2. else one refused only on LIFECYCLE    → its name, unlinked;
  //   3. else, if anything was lost to MATURITY → nothing at all (below);
  //   4. else no candidates existed            → the `clientName` fallback.
  // Step 2 deliberately excludes maturity-refused candidates instead of taking
  // `candidates[0]`: with the maturity-refused one sorting first, `[0]` would
  // hand back the very name this host must not acknowledge.
  const chosen =
    candidates.find((c) => c.viewable) ?? candidates.find((c) => !c.maturityRefused) ?? null;

  // 🔴 EVERY remaining candidate was refused on MATURITY — so this host does not
  // acknowledge this app at all, and that includes refusing the `clientName`
  // fallback (which is the same string anyway for an `appblk-` client, the reason
  // gagging only the listing name would have been a no-op). Guarded on
  // `candidates.length` so it cannot reach the no-listing / shadow-revision
  // cases, which produce no candidates and lost nothing to maturity.
  if (!chosen && candidates.length > 0) return null;

  const name = chosen?.name || clientName;
  // No name from either side ⇒ nothing nameable to render. A chip reading
  // "Published with" and then nothing is worse than no chip.
  if (!name) return null;

  return {
    slug: chosen?.viewable ? chosen.slug : null,
    name,
    iconUrl: chosen?.viewable ? chosen.iconUrl : null,
  };
}

/**
 * The WHOLE server-side decision, with both database reads injected.
 *
 * 🔴 THE INJECTION IS THE POINT, and so is the ORDER. The gate must run before
 * the marker is read and the marker must resolve before the app is looked up. A
 * test over the projector alone cannot see either ordering; with the reads
 * injected a test asserts that `readApp` was never even CALLED for a post with
 * no marker (so the common path takes no extra query) and that NEITHER read was
 * called for a viewer without store visibility.
 *
 * ## 🔒 Why the store-visibility scope gates a DISPLAY chip
 *
 * The App Store detail surface is not yet public: `resolveStoreVisibilityScope`
 * admits an on-site listing only at scope `full` (moderators + app-dev-testers),
 * and an anonymous viewer resolves `none`. Post detail, by contrast, is fully
 * public. An ungated chip would publish app NAMES — and the existence of App
 * Blocks — onto public post pages ahead of the store launch, and would hand a
 * `/apps/store-preview/<slug>` link to viewers the destination refuses to serve.
 *
 * So the chip renders only where an ON-SITE listing is admissible, which today
 * is scope `full` alone (mods + app-dev-testers). That cohort sees it linked
 * now; everyone sees it when the store flag widens, with no second change.
 *
 * 🔴 "NO SECOND CHANGE" IS TRUE OF BEHAVIOUR AND FALSE OF COST — the single most
 * important fact about this module's production footprint, and one that is
 * invisible to every measurement anyone can take before the flip. Today the gate
 * below is false for essentially all traffic, so the whole I/O half of this
 * function is dead code in production and the feature measures as free. The
 * moment the store scope admits the public, EVERY post-detail read starts paying,
 * per view: one Redis GET plus one `Post.findUnique` by primary key on a very
 * large hot table (and, inside the replication-lag window, against the write
 * primary) — plus, for an app-published post, four more replica queries for the
 * app row.
 *
 * `post_app_chip_reads_total{outcome="gated"}` is the tripwire: while it
 * dominates, none of the above is happening. When it stops dominating, it all
 * is — and `readApp`'s cache note in `post-app-chip.service.ts` is the lever to
 * reach for first.
 *
 * ⚠️ AND THE CHIP MAKES POST DETAIL DEPEND ON THREE FLIPT KEYS CONTINUING TO
 * EXIST: `app-listings`, `app-blocks-enabled`, `app-listings-public-external`.
 * All three exist today. If one is deleted or renamed, `evaluateBoolean` THROWS,
 * and the throw bypasses the boolean eval cache so the result is never memoised —
 * so the default `onEvalError` would `console.error` on EVERY post-detail read,
 * indefinitely. That failure mode is recorded twice elsewhere in this repo; what
 * changed here is its blast radius, which used to be the `/apps` store and is now
 * the busiest public page on the site. Nothing enforces the dependency.
 *
 * 🔴 THE GATE IS THE SHARED `scopeAdmitsListingKind(scope, 'onsite')`, NOT A
 * HAND-SPELLED `!== 'full'`. The two agree today, and the shared one is what
 * keeps them agreeing: it is a `switch` over the closed scope union, so adding a
 * fourth scope is a COMPILE ERROR there rather than a silent open or a silent
 * stay-dark here. Its own header exists because a surface that re-derived this
 * question disagreed with the read path and shipped a cohort an affordance the
 * data layer then refused.
 *
 * `'onsite'` is passed unconditionally and that is the conservative reading, not
 * an assumption: the gate runs BEFORE any read, so the listing's real `kind` is
 * unknown here, and an `appBlockId` is not a kind discriminator anyway. Asking
 * "may this viewer learn that an on-site app exists" is the question the
 * operator's decision was made about.
 *
 * 🔴 `storeScope` is REQUIRED and must come from the SERVER resolver
 * (`resolveStoreVisibilityScope({ user })`), never re-derived from the client
 * `features` object. They are two evaluations of the same flags and they CAN
 * disagree — a Flipt outage makes the client fall back to each flag's static
 * `availability` while the server has no such fallback. This is a disclosure
 * gate, so it must key off the same value the DATA layer keys off. A default
 * would let a new caller silently re-open the disclosure, so there isn't one —
 * and `post-app-chip.service.test.ts` pins that the wiring actually passes the
 * resolver's answer through, because a literal `'full'` substituted at the call
 * site defeats this entire gate without failing anything in THIS module's tests.
 */
export async function resolvePostAppChip(args: {
  postId: number;
  storeScope: StoreVisibilityScope;
  /** The request's host, for the maturity term. See {@link projectPostAppChip}. */
  host: string;
  /** Narrow marker read. Build its args with {@link postAppMarkerQuery}. */
  readPostMetadata: (postId: number) => Promise<unknown>;
  /** Allowlisted app read. Build its args with {@link postAppChipQuery}. */
  readApp: (appId: string) => Promise<PostAppChipRow | null | undefined>;
  /**
   * Which of these listing ids the per-listing VISIBILITY LEVEL hides from a general
   * viewer. REQUIRED, so the fourth term of the destination's predicate cannot be
   * forgotten — see {@link readListingCandidate}.
   */
  readHiddenListingIds: (listingIds: string[]) => Promise<ReadonlySet<string>>;
}): Promise<PostAppChipResolution> {
  // 🔒 GATE FIRST — before the marker is read, before anything is queried.
  if (!scopeAdmitsListingKind(args.storeScope, 'onsite')) {
    return { chip: null, outcome: 'gated' };
  }

  const metadata = await args.readPostMetadata(args.postId);
  const appId = readBlockPublishedAppId(metadata);
  // No marker ⇒ an ordinary hand-made post. NO app lookup: this is the common
  // path and it must cost nothing extra.
  if (!appId) return { chip: null, outcome: 'no-marker' };

  const row = await args.readApp(appId);
  // 🔴 THE LEVEL TERM, RESOLVED ONCE FOR EVERY CANDIDATE. Injected like the other two
  // readers so this module stays DB-free; batched so a post view costs ONE extra statement
  // regardless of how many blocks the client has, rather than an N+1 on a page-view-rate
  // path. Skipped entirely when the row carries no listing, which is the common case.
  const listingIds = listingIdsInChipRow(row ?? null);
  const hiddenListingIds = listingIds.length
    ? await args.readHiddenListingIds(listingIds)
    : EMPTY_HIDDEN;
  const chip = projectPostAppChip(row ?? null, { host: args.host, hiddenListingIds });
  return { chip, outcome: chip ? 'chip' : 'unresolved' };
}
