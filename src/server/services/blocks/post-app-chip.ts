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
 * allowlisted columns ({@link postAppChipQuery}) and the PROJECTOR emits only
 * {@link POST_APP_CHIP_KEYS} ({@link projectPostAppChip}). Same posture as
 * `public-owner.ts`: adding a field in either place is a deliberate act.
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
 * marker, and there are THREE branches, not two:
 *
 *   a. marker resolves to no `OauthClient`  → NO CHIP (`null`).
 *   b. resolves, but not publicly viewable → chip with `slug: null` (name
 *      rendered UNLINKED).
 *   c. resolves and is publicly viewable   → chip with a `slug` (name linked).
 *
 * ## The viewability predicate, and the link target
 *
 * VIEWABLE = `app_listings.status = 'approved'` AND `app_blocks.status =
 * 'approved'`, reached as `OauthClient.id → app_blocks.app_id →
 * app_listings.app_block_id`. All three tables are in the MAIN database (
 * `AppBlock` is an ordinary Prisma model, `@@map("app_blocks")`), so this is one
 * same-DB read and NOT a cross-database query on a public page load.
 * `requireAppsDb()` is an unrelated mechanism (the per-app storage schemas) and
 * is deliberately not involved.
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
 */
import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { listingIconUrl } from '~/server/services/blocks/listing-media-url';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

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
 * The chip's complete key set, sorted. Exported so the projection test asserts
 * the emitted object against a literal rather than against the type (a type
 * declaration is not a runtime guard).
 */
export const POST_APP_CHIP_KEYS = ['iconUrl', 'name', 'slug'] as const;

/** The `Post.metadata` key the publish path writes the app's `OauthClient.id` into. */
export const POST_APP_MARKER_KEY = 'blockPublishedAppId';

/** The status both `app_listings` and `app_blocks` must hold to be publicly viewable. */
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
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[POST_APP_MARKER_KEY];
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
 * `appListing` is a to-one (`AppListing.appBlockId` is `@unique`). `status` is
 * selected on BOTH sides because viewability needs both, and `revisionOfId` is
 * selected so the projector can reject a shadow revision rather than trusting
 * that a revision can never hold the unique `appBlockId` — defence in depth on
 * a public read, matching `approvedListingSlugQuery`.
 */
export function postAppChipQuery(appId: string) {
  return {
    where: { id: appId },
    select: {
      name: true,
      appBlocks: {
        select: {
          status: true,
          appListing: {
            select: {
              slug: true,
              name: true,
              status: true,
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

type ListingCandidate = { slug: string; name: string; iconUrl: string | null; viewable: boolean };

function readListingCandidate(block: unknown): ListingCandidate | null {
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
    viewable: b.status === APPROVED_STATUS && l.status === APPROVED_STATUS,
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
export function projectPostAppChip(row: PostAppChipRow | null | undefined): PostAppChip | null {
  if (!row) return null;
  const clientName = typeof row.name === 'string' ? sanitizeAppChromeName(row.name) ?? '' : '';
  const blocks = Array.isArray(row.appBlocks) ? row.appBlocks : [];
  const candidates = blocks
    .map(readListingCandidate)
    .filter((c): c is ListingCandidate => c !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const chosen = candidates.find((c) => c.viewable) ?? candidates[0] ?? null;
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
 * So the chip renders only at scope `full`. That cohort sees it linked today;
 * everyone sees it automatically when the store flag widens, with no second
 * change. It is an ALLOWLIST (`!== 'full'`), not a denylist on the other scopes,
 * because a denylist fails OPEN the moment a fourth scope is added — and the
 * scope union is exactly the kind of thing that grows.
 *
 * 🔴 `storeScope` is REQUIRED and must come from the SERVER resolver
 * (`resolveStoreVisibilityScope({ user })`), never re-derived from the client
 * `features` object. They are two evaluations of the same flags and they CAN
 * disagree — a Flipt outage makes the client fall back to each flag's static
 * `availability` while the server has no such fallback. This is a disclosure
 * gate, so it must key off the same value the DATA layer keys off. A default
 * would let a new caller silently re-open the disclosure, so there isn't one.
 */
export async function resolvePostAppChip(args: {
  postId: number;
  storeScope: StoreVisibilityScope;
  /** Narrow marker read. Build its args with {@link postAppMarkerQuery}. */
  readPostMetadata: (postId: number) => Promise<unknown>;
  /** Allowlisted app read. Build its args with {@link postAppChipQuery}. */
  readApp: (appId: string) => Promise<PostAppChipRow | null | undefined>;
}): Promise<PostAppChip | null> {
  // 🔒 GATE FIRST — before the marker is read, before anything is queried.
  if (args.storeScope !== 'full') return null;

  const metadata = await args.readPostMetadata(args.postId);
  const appId = readBlockPublishedAppId(metadata);
  // No marker ⇒ an ordinary hand-made post. NO app lookup: this is the common
  // path and it must cost nothing extra.
  if (!appId) return null;

  const row = await args.readApp(appId);
  return projectPostAppChip(row ?? null);
}
