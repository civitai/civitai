import {
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconApps, IconThumbUp } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { CATEGORY_ICONS, FALLBACK_CATEGORY_ICON } from '~/components/Apps/marketplaceCategoryIcons';
import {
  getListingCta,
  getListingDetailHref,
  getRecommendLabel,
} from '~/components/Apps/appListingCardView';
import {
  LISTING_ACTION_ROW_CONTROL_PX,
  LISTING_ACTION_ROW_GAP_PX,
  LISTING_ACTION_ROW_HEIGHT_PX,
  LISTING_ACTION_ROW_PT_PX,
  LISTING_CARD_COVER_ASPECT_RATIO,
  LISTING_CARD_ICON_SIZE_PX,
  LISTING_CARD_TITLE_LINES,
  LISTING_CARD_TITLE_LINE_HEIGHT,
  LISTING_CARD_TITLE_MIN_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
import { AppListingActionsMenu } from '~/components/Apps/AppListingActionsMenu';
import { ACTION_GLYPH_ICONS, cardActionGlyph } from '~/components/Apps/appListingActionGlyph';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { toRecentAppFromListing } from '~/components/Apps/recentAppsRail';
import { recordRecentlyOpenedApp } from '~/components/Apps/recentlyOpenedAppsStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import {
  appInitial,
  listingPlaceholderGradient,
} from '~/shared/constants/app-listing-placeholder.constants';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2b unified store CARD, over BOTH kinds.
 *
 * Renders one `ListingCard` (from `appListings.listAvailable`): cover + app icon
 * + name + tagline + creator chip + the Steam-style recommend rollup + a
 * kind-aware CTA (Open / View details / Visit ↗). Mirrors the visual language of
 * the live `AppBlockCard` (Mantine Card + category-glyph cover placeholder) so
 * listings feel native.
 *
 * 🔴 THE CARD'S GEOMETRY IS NOT SPELLED HERE — it is READ from
 * `appListingCardGeometry.ts`: cover ratio, icon size, reserved title lines and
 * line-height, action-row height / padding / gap / control size. The reason is a
 * relationship this file cannot enforce on its own: `AppListingCardSkeleton` must
 * reserve EXACTLY this geometry or the grid reflows when the query resolves, and
 * two hand-copied numbers is how that drifts. Do not re-literalise a value below
 * "for readability" — the literal is the bug.
 *
 * 🔴 AND "READS THEM" MEANS ALL OF THEM, WHICH IS NOW MACHINE-CHECKED AGAINST THE
 * MODULE'S EXPORTS. This header claimed the action-row HEIGHT among them while
 * nothing here consumed it; the row's `mih` is that consumer, and
 * `__tests__/appListingCardView.test.ts` enumerates the module's `Object.keys`
 * rather than a hand-maintained list, so the claim cannot quietly outgrow the code
 * again.
 *
 * 🔴 THE RECOMMEND ROLLUP LIVES IN THE META BLOCK, NOT THE ACTION ROW. It used to
 * sit opposite the CTA under `justify="space-between"`, which cost an enforced
 * `min-width` floor, a `@container` breakpoint that hid it entirely below 264px,
 * and a derived threshold constant with its own drift guard — all of it apparatus
 * for making two things share a row that did not need to. As a dimmed line under
 * the creator chip it has the meta block's full width, never competes with the
 * CTA, and the row is left holding only the CTA + the `⋮` trigger. Whether a
 * viewer gets a `⋮` no longer has any geometry consequence beyond the trigger's
 * own 36px, so the card no longer computes that predicate at all.
 *
 * 🔴 THERE IS NO KIND BADGE ON THIS CARD. This line used to claim "a kind badge
 * (App / Connect app / Off-site)" — doubly wrong: two of those labels no longer
 * exist (the off-site display sub-kind was collapsed), and the card does not
 * render a badge at all. The evidence is the IMPORT GRAPH, checkable by grep:
 * `getListingBadge` lives in `appListingCardView` and is imported by two test
 * files and nothing else — this component does not import it. (There is an
 * "Off-site is absent" check in `AppListingCard.browser.test.tsx`, but it uses
 * the `expect.element(...).not.toBeInTheDocument()` form that is INERT in this
 * repo — issue #4197 — so it is not evidence of anything. Don't cite it.)
 * The kind signal here is the CTA (an external "Visit" anchor vs. an internal
 * Open / View details link), plus the off-site disclosure on the detail page.
 *
 * LIVE (P2d cut over): this is the DEFAULT `/apps` store card
 * (`AppListingsMarketplaceBody` → `AppListingCard`) over BOTH kinds. The page is
 * still flag-gated (the App Blocks Flipt segment + `deIndex`) — no longer
 * "store-preview only". The unified DETAIL still lives at
 * `/apps/store-preview/<slug>`.
 *
 * Reuse note: the plan (§6.1) suggests rendering through `AspectRatioImageCard`
 * for cosmetic frames + per-image maturity blur. That component's image slot
 * needs a full `Image` object (id / nsfwLevel / hash / metadata / type), but the
 * P2a public DTO deliberately projects only a bare `coverUrl`/`iconUrl` string
 * (allowlist — no per-image internals). The listing read is already maturity-
 * gated server-side (r/x hidden off a red-capable host), so we mirror
 * AppBlockCard's proven Mantine-Card + placeholder pattern here. Feeding
 * AspectRatioImageCard (cosmetic frames) would need the DTO to carry the Image
 * object — a P2a schema addition, out of scope for P2b (flagged in the PR).
 */

function categoryIcon(category: string): Icon {
  return isMarketplaceCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

/**
 * Card cover — the listing's cover image (`coverUrl`, already a CDN URL, with the
 * first screenshot as a server-side fallback). When absent, a category-glyph
 * placeholder over the listing's DETERMINISTIC PER-APP seeded gradient (shared
 * with the server-generated cover SVG — see
 * `~/shared/constants/app-listing-placeholder.constants`), so a card is never a
 * broken/empty `<img>` and two coverless listings never look identical.
 * Decorative (aria-hidden) — the placeholder carries no info the title/category
 * chip don't.
 *
 * GEOMETRY (feedback #1: "make cover images larger"): the cover is a RESPONSIVE
 * 16:9 box (a `Box` with a CSS `aspect-ratio`), not the former fixed `h={140}`.
 * Two reasons:
 *   1. It scales with the column, so widening the grid (5 → 4 cols at `xl`)
 *      actually makes the art bigger instead of leaving a short letterbox. The
 *      server already serves the cover at `width: 1200` (app-listing.service),
 *      so there is ~8× resolution headroom — this is a pure client-side change,
 *      no DTO/pipeline work.
 *   2. CLS: `aspect-ratio` derives the box height from the (already-known) column
 *      width BEFORE the image loads, so a slow or failed cover never shifts the
 *      card. The old fixed height did too — the point is that the responsive box
 *      KEEPS that property rather than trading it away for scale.
 * The image branch and the placeholder branch render inside the SAME box, so the
 * `onError` fallback swaps art without ANY reflow.
 */
function ListingCover({
  coverUrl,
  category,
  name,
  slug,
}: {
  coverUrl: string | null;
  category: string | null;
  name: string;
  slug: string;
}) {
  // A non-null coverUrl can still 404 (the server derives it from a first-
  // screenshot fallback, whose Image can dangle) — fall back to the category
  // glyph placeholder on load error instead of a broken <img>.
  const [broken, setBroken] = useState(false);
  const showImage = !!coverUrl && !broken;
  const PlaceholderIcon = category ? categoryIcon(category) : IconApps;
  // Per-app SEEDED gradient (not one uniform grey for every coverless listing) —
  // same seed + stops the generated cover SVG uses, so a listing that later gets
  // a real generated asset keeps its colour identity. See
  // `~/shared/constants/app-listing-placeholder.constants`.
  return (
    <Card.Section>
      <Box
        data-testid="apps-listing-cover"
        style={{
          // The ratio box. `aspect-ratio` derives the height from the (fluid)
          // column width, so the cover grows with the card AND its height is
          // reserved before any image bytes arrive — that's the CLS guard.
          position: 'relative',
          width: '100%',
          // Read, not spelled — the skeleton reserves the SAME ratio.
          aspectRatio: LISTING_CARD_COVER_ASPECT_RATIO,
          overflow: 'hidden',
        }}
      >
        {showImage ? (
          <Image
            src={coverUrl}
            alt={`${name} cover image`}
            fit="cover"
            onError={() => setBroken(true)}
            // Absolutely filling the ratio box, NOT `h="100%"`: a percentage
            // height has to resolve against a block size that is itself derived
            // from `aspect-ratio`. Every current engine does that, but if it ever
            // resolved to `auto` the image would render at its intrinsic size and
            // `overflow: hidden` would silently CROP it — a failure no test that
            // reads style strings could catch. `inset: 0` needs no such
            // resolution.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        ) : (
          <Box
            aria-hidden
            data-testid="apps-listing-cover-placeholder"
            data-listing-cover-placeholder=""
            className="flex items-center justify-center"
            style={{
              // Fills the ratio box exactly (same absolute encoding as the image),
              // so swapping art on `onError` cannot change the card's geometry.
              position: 'absolute',
              inset: 0,
              // Per-app SEEDED gradient (#3465) — NOT the old uniform grey, so two
              // coverless listings never look identical and a listing keeps its
              // colour identity if it later gains a generated cover SVG.
              background: listingPlaceholderGradient({ slug, category, surface: 'cover' }),
            }}
          >
            <PlaceholderIcon size={56} className="opacity-60" />
          </Box>
        )}
      </Box>
    </Card.Section>
  );
}

/**
 * "by {creator}" chip — restores the attribution line AppBlockCard dropped. Uses
 * the public creator chip (id / username / image). Links to the creator profile.
 * (UserAvatarSimple wants a rich `ProfileImage` + cosmetics object; the DTO only
 * carries a bare `image` string, so we render a lightweight avatar here — noted
 * as a reuse tradeoff in the PR.)
 */
function CreatorChip({ creator }: { creator: ListingCard['creator'] }) {
  if (!creator || !creator.username) return null;
  const avatarSrc = creator.image ? getEdgeUrl(creator.image, { width: 64 }) : undefined;
  return (
    <Anchor
      component={Link}
      href={`/user/${encodeURIComponent(creator.username)}`}
      underline="never"
      c="dimmed"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <Avatar src={avatarSrc} alt="" radius="xl" size={20} style={{ flexShrink: 0 }}>
          {creator.username.charAt(0).toUpperCase()}
        </Avatar>
        {/* Tuned to fit in the common case; the Tooltip reveals a long username
            only when it would still clip. */}
        {/* 🔴 S5 — AUTHOR is size + weight ONLY: 12px/400 -> 14px/500, matching the
            `/models` author line. `c="dimmed"` is KEPT deliberately (Zach's call):
            taking BOTH title and author to white flattens the title-over-author
            hierarchy on a `dark-6` card body, and `/models` needs white there only
            because its author line is overlaid on media.

            🔴 ACCEPTED RESIDUAL, on the record rather than an oversight: this leaves
            the author line at contrast 4.73 — AA pass by 0.23, AAA fail. Do not
            "fix" it to white in a later PR without revisiting that decision; the
            verification asserts the colour did NOT change. */}
        <TruncatedText
          size="sm"
          fw={500}
          c="dimmed"
          lineClamp={1}
          tooltipLabel={creator.username}
          style={{ minWidth: 0 }}
        >
          {`by ${creator.username}`}
        </TruncatedText>
      </Group>
    </Anchor>
  );
}

export interface AppListingCardProps {
  card: ListingCard;
  /**
   * Whether the viewer can open a full-page app (the `appBlocksPages` flag). When
   * false an on-site page app's CTA falls back to "View details" instead of a
   * dead "Open" link (the `/apps/run/<slug>` route 404s without the flag).
   */
  canOpenPage?: boolean;
  /**
   * Moderator listing-media review renders this card READ-ONLY, over an
   * UNAPPROVED shadow listing (`OffsiteReviewQueue`). Suppresses the `⋮` menu, for
   * exactly the reason `AppListingDetailBody` takes the same prop: the reviewer IS
   * a moderator, so without it a preview card would offer live takedown actions
   * against a listing whose status — and whose `id` — are not guaranteed. See
   * `appListingDetailModActions.detailListingStatus`.
   */
  preview?: boolean;
}

export function AppListingCard({
  card,
  canOpenPage = false,
  preview = false,
}: AppListingCardProps) {
  const currentUser = useCurrentUser();
  const cta = getListingCta(card, { canOpenPage });
  // 🔴 S6b — ONE glyph vocabulary, read from the shared module rather than a
  // second inline copy. #3539 already gave each CTA its own icon; what was still
  // missing is a single SOURCE, so the card, the listing detail and the recents
  // rail could not drift apart silently. This substitution renders exactly the
  // same three icons it did before (open → IconPlayerPlay, visit →
  // IconExternalLink, detail → IconEye) — it is a consolidation, not a restyle.
  const CtaGlyph = ACTION_GLYPH_ICONS[cardActionGlyph(cta.action)];
  const detailHref = getListingDetailHref(card.slug);
  const recommendLabel = getRecommendLabel(card.recommend, card.reviewCount);

  const isOwner = !!currentUser?.id && currentUser.id === card.creator?.id;

  // The `⋮` overflow menu's target. Owner Edit — which used to be two hand-rolled
  // buttons right here — now lives inside the SHARED `AppListingActionsMenu`,
  // alongside review / report / the moderator section, so the card and the listing
  // detail cannot drift apart about what the menu holds.
  const menuTarget = {
    id: card.id,
    slug: card.slug,
    kind: card.kind,
    kindData: card.kindData,
    creatorUserId: card.creator?.id ?? null,
  };
  // OWNER-ONLY incompleteness hint. The public store DTO carries only nullable
  // iconUrl/coverUrl (no screenshot count), so this is scoped to a below-floor
  // listing (missing icon or cover). A non-owner / public shopper always sees a
  // normal card (the cover placeholder already handles a missing cover). Small +
  // subtle by design — a nudge to the owner, never a public "broken" signal.
  const missingFloorAssets = [
    card.iconUrl == null ? 'icon' : null,
    card.coverUrl == null ? 'cover' : null,
  ].filter((v): v is string => v != null);
  const showOwnerIncomplete = isOwner && missingFloorAssets.length > 0;

  // 🔴 `@container` IS GONE, AND SO IS THE `hasMenu` PREDICATE THAT DROVE IT.
  // The card declared itself a query container for exactly ONE consumer: the
  // recommend rollup's `hidden @[264px]:flex`. With the rollup relocated to the
  // meta block there is no container query left on this card, so keeping
  // `container-type: inline-size` would be an unread containment declaration
  // that a later reader has to prove unused before touching. Nothing else on the
  // card is size-queried; re-add it WITH its consumer if that changes.
  // (`useAppListingActionsMenuVisible` went with it. That hook is now DELETED, not
  // merely uncalled: it existed solely so this card could lay out around the
  // trigger, so once the layout stopped depending on the answer it had no consumer
  // anywhere — and an exported hook with no consumer is the same shape as an unread
  // containment declaration, i.e. the thing that gets wired back in later.)
  // 🔴 S4 — CHROME MATCHES THE SITE'S CARD, and every property below is
  // load-bearing. Measured against a `/models` card in the same session (dark),
  // and re-measured at 394px mobile where all four values are identical:
  //   border-radius  8px           -> 6px   (`rounded-md`)
  //   border         0.877px solid -> 0px   (drop `withBorder`)
  //   box-shadow     3-layer       -> none  (drop `shadow="sm"`)
  //   background     rgb(37,38,43) -> unchanged
  // The site baseline is `TwCard`'s `rounded-md border-gray-3 bg-gray-0
  // shadow-gray-4`, where the absent border/shadow is EMERGENT: those classes set
  // only a COLOUR, with no width/shadow utility, so both resolve to 0/none.
  //
  // 🔴 `radius={0}` + `rounded-md`, NOT `radius="md"`. Mantine's `md` is 8px and
  // Tailwind's `rounded-md` is 6px — the two `md`s are different values, which is
  // exactly how this drifted. Taking it from the Tailwind scale pins it to the same
  // token the rest of the site's cards use.
  //
  // 🔴 PADDING STAYS 16px. The review's "zero padding" is about the MEDIA, and the
  // cover is already full-bleed via `<Card.Section>`. Unlike `/models`, this card's
  // text sits BELOW the media rather than overlaid on it, so the body needs padding.
  //
  // Losing the border is safe at 1-per-row mobile, where the card is effectively
  // full-bleed: the card's own fill (rgb(37,38,43)) separates it from the page
  // (rgb(26,27,30)) with every ancestor transparent — the same separation `/models`
  // already relies on at `border: 0`. Measured, not assumed.
  return (
    <Card padding="md" radius={0} className="h-full rounded-md">
      <ListingCover
        coverUrl={card.coverUrl}
        category={card.category}
        name={card.name}
        slug={card.slug}
      />
      <Stack gap="sm" h="100%" pt="sm">
        <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          {/* App icon (square, publisher-supplied). Decorative — the title
              carries the accessible name; a missing icon falls back to the
              app's initial. */}
          <Avatar
            src={card.iconUrl ?? undefined}
            alt=""
            radius="md"
            size={LISTING_CARD_ICON_SIZE_PX}
            style={{ flexShrink: 0 }}
            data-listing-icon-placeholder={card.iconUrl == null ? '' : undefined}
            styles={{
              // Missing icon → the SAME seeded monogram the generated icon SVG
              // renders (per-app hue + first-alphanumeric initial), instead of
              // Mantine's default flat grey placeholder.
              placeholder: {
                background: listingPlaceholderGradient({
                  slug: card.slug,
                  category: card.category,
                  surface: 'icon',
                }),
                color: 'var(--mantine-color-white)',
                fontWeight: 700,
              },
            }}
          >
            {appInitial(card.name, card.slug)}
          </Avatar>
          <Stack gap={2} style={{ minWidth: 0 }}>
            {/* Title links to the unified detail so the detail is reachable
                from every card even when the primary CTA is a direct Open /
                Visit. underline:hover keeps it visibly a link. */}
            <Anchor
              component={Link}
              href={detailHref}
              underline="hover"
              c="inherit"
              style={{ minWidth: 0 }}
            >
              {/* 🔴 S5 — TITLE matches the `/models` card: 18px/700/rgb(193,194,197)
                  (contrast 8.48) -> 20px/700/#fefefe (contrast 14.97). `c="white"`
                  is `--mantine-color-white`, which ThemeProvider sets to #fefefe
                  deliberately to match the Tailwind value — it is the token the
                  site's own card components use, so prefer it over the review's
                  suggested `--mantine-primary-color-contrast` (same rendered value,
                  wrong token).

                  🔴 Do NOT add `cardClasses.dropShadow`. The `/models` title carries
                  a text-shadow because it sits OVER media; this one sits on the card
                  body. Confirmed still true at 394px mobile.

                  ⚠️ SEMANTIC SIDE EFFECT, declared not hidden: dropping `<Title
                  order={4}>` removes the `h4` from each card — parity with
                  `/models`, whose card title is a `<p>`. Grepped: nothing depends
                  on a heading inside the card (no `getByRole('heading')`, no
                  snapshot). 🔴 It does NOT leave `/apps` heading-less, as an
                  earlier draft of this comment claimed: `RecentlyOpenedApps`
                  ("Recently opened") and `RelatedListings` both render their own
                  `Title` on those surfaces. The broader heading-hierarchy finding
                  (S13) stays out of scope.

                  🔴 THE TITLE BOX RESERVES ITS FULL TWO LINES WHETHER OR NOT IT
                  NEEDS THEM. `min-height` = lines x line-height, in `em` so it
                  tracks the title's own font-size. Without it a one-line title is
                  24px and a wrapped one is 48px, so the creator chip — and every
                  row of the meta block under it — lands at a DIFFERENT y on every
                  card in a grid row, which reads as sloppy alignment rather than
                  as variable content. It adds NO truncation: the title already
                  clamped at two lines, and the clamp is still two lines because
                  both numbers are now the same constant.

                  🔴 `TruncatedText` REPLACES the `line-clamp-2` utility class, and
                  the swap is not cosmetic. (a) The class would be a SECOND copy of
                  the line count that `min-height` derives from — exactly the drift
                  this PR's geometry module exists to remove. (b) It buys the
                  hover fallback the creator chip already has: a name clamped at
                  two lines is unreadable, and `TruncatedText` reveals it in a
                  Tooltip ONLY when it actually clips (a runtime scrollHeight
                  measurement, not a guess). `clampLines` selects that component's
                  multi-line mode — passing the Tailwind class instead would be
                  silently overridden by its single-line `white-space: nowrap`. */}
              <TruncatedText
                size="xl"
                fw={700}
                lh={LISTING_CARD_TITLE_LINE_HEIGHT}
                c="white"
                clampLines={LISTING_CARD_TITLE_LINES}
                tooltipLabel={card.name}
                style={{ minHeight: LISTING_CARD_TITLE_MIN_HEIGHT }}
              >
                {card.name}
              </TruncatedText>
            </Anchor>
            <CreatorChip creator={card.creator} />
            {/* ── THE RECOMMEND ROLLUP ────────────────────────────────────────
                "N% recommend (M)", or "No reviews yet" when there are none.

                🔴 IT ALWAYS RENDERS, AND THAT IS THE POINT. A card with no reviews
                still gets the line — dropping it would make card heights depend on
                review state inside an `h-full` grid row, which is the same class of
                misalignment the title's reserved lines above fix.

                🔴 IT MOVED HERE FROM THE ACTION ROW, and what it left behind is the
                headline of this change. Opposite the CTA it needed an enforced
                `min-width` floor (so a growing CTA could not starve it), a
                `@container` query hiding it below 264px (so a narrow card did not
                render a two-character stub), and a derived threshold constant with
                a drift guard asserting the Tailwind class spelled the same number.
                All three are DELETED: as a meta-block line it has the block's full
                width, competes with nothing, and truncates against the card body
                rather than against a button.

                Dimmed + `xs`, i.e. quieter than the creator line above it: it is
                corroboration, not identity. */}
            <Group
              gap={4}
              wrap="nowrap"
              style={{ minWidth: 0 }}
              data-testid="apps-listing-recommend-rollup"
            >
              <IconThumbUp
                size={13}
                style={{ flexShrink: 0 }}
                className={card.recommend.recommendPct == null ? 'text-gray-500' : 'text-green-500'}
              />
              <Text size="xs" c="dimmed" truncate>
                {recommendLabel}
              </Text>
            </Group>
            {/* AUTHOR-DECLARED beta label. Matches the `Incomplete` badge's shape directly
                below, with two deliberate differences: it is PUBLIC (that one is owner-only
                — `showOwnerIncomplete`), and it carries no tooltip, because the card DTO
                carries no `betaMessage` to put in one. The note lives on the detail page,
                where there is room to read it. `card.isBeta` is `false` both for "not in
                beta" and while the manual-apply migration is outstanding. */}
            {card.isBeta && (
              <Badge
                color="violet"
                variant="light"
                size="xs"
                style={{ alignSelf: 'flex-start' }}
                data-testid="apps-listing-card-beta"
              >
                Beta
              </Badge>
            )}
            {showOwnerIncomplete && (
              <Tooltip
                label={`Missing ${missingFloorAssets.join(' and ')} — add ${
                  missingFloorAssets.length > 1 ? 'them' : 'it'
                } from Edit to complete your listing.`}
                withArrow
                multiline
                w={220}
              >
                <Badge
                  color="yellow"
                  variant="light"
                  size="xs"
                  style={{ cursor: 'help', alignSelf: 'flex-start' }}
                  data-testid="apps-listing-owner-incomplete"
                >
                  Incomplete
                </Badge>
              </Tooltip>
            )}
          </Stack>
        </Group>

        {card.tagline && (
          <Text size="sm" c="dimmed" className="line-clamp-3">
            {card.tagline}
          </Text>
        )}

        {/* ── THE ACTION ROW ────────────────────────────────────────────────
            Feedback #2: the buttons sit one notch up the Mantine size scale (xs
            → sm), so the primary CTA reads as the card's call to action rather
            than a footnote. S7 then made the CTA FILL the row instead of
            stepping up the size scale again — see the CTA's own note below.

            🔴 THE ROW HOLDS THE CTA AND THE `⋮` TRIGGER, AND NOTHING ELSE. The
            recommend rollup used to sit opposite them; it is now a meta-block
            line (see its note above). Three pieces of apparatus died with the
            move, and none of them should come back with it:
              - `justify="space-between"` — moot with one growing child, and it
                was the reason a lone item could jump to flex-START;
              - `marginLeft: 'auto'` on the action cluster — it existed as a
                SECOND mechanism keeping the actions right-aligned when the
                rollup was hidden. There is no "hidden rollup" state any more and
                the CTA reaches both edges by growing, so an auto margin now has
                exactly zero free space to absorb at every width. Kept, it would
                be a guard for a hazard that no longer has a shape — dead code
                that reads as load-bearing. DELETED;
              - the nested action-cluster `Group` — it existed to keep the CTA and
                the trigger together as one flex item opposite the rollup. With
                the rollup gone the row IS that cluster, so the wrapper is one
                level of nesting with nothing left to group.

            🔴 The row still stays `nowrap`. With one growing CTA a wrapped line
            would put the `⋮` on its own row, and a card WITH a menu would then be
            taller than one without — inside an `h-full` grid row that grows every
            card in the row across the store.

            🔴 ROW HEIGHT IS A CONSTANT 46px AND MUST STAY ONE, and it is now
            DERIVED rather than asserted: `LISTING_ACTION_ROW_HEIGHT_PX` =
            `LISTING_ACTION_ROW_PT_PX` (10) + `LISTING_ACTION_ROW_CONTROL_PX`
            (36), and this row reads all three.

            🔴 `mih` IS THE HEIGHT CONSTANT'S ONLY PRODUCTION READ, AND IT IS HERE
            BECAUSE OF WHAT ITS ABSENCE COST. The height was DERIVED in the module
            and MEASURED in the browser suite, but nothing in production consumed
            it — so the module's own header, this file's header and a test titled
            "reads EVERY geometry constant" all claimed a coverage that did not
            exist, and the test's loop quietly enumerated 8 of 9. An audit produced
            the defect that gap admits: adding `pb={10}` beside the `pt` renders a
            56px row while the constant still says 46, and the BLOCKING node tier
            stays entirely green because it measures nothing. PR3's skeleton would
            then import 46, reserve 10px too little, and reflow the grid — exactly
            what this module exists to prevent, in the one tier CI does not gate.
            `mih` makes the read real (and is not inert: it holds the row at 46 if a
            control ever renders SHORTER), and the node tier now asserts this tag's
            whole PROP LEDGER, so a `pb` — or any other prop that can move the
            row's height — fails the blocking tier rather than only the browser one.
            🔴 DO NOT ADD A PROP HERE WITHOUT UPDATING THAT LEDGER; that is the
            point of it, not an obstacle to route around.

            Every control in it is that same 36:
            the `sm` CTA button and the `⋮` trigger, which takes its size from the
            constant rather than a literal. The row lives in an `h-full` grid row,
            so a taller control here propagates to every card in that row across
            the whole store — which is why the CTA grows HORIZONTALLY rather than
            up the size scale. Pinned at container 248 / 282 / 462 in
            `AppListingCard.browser.test.tsx`. */}
        <Group
          mt="auto"
          pt={LISTING_ACTION_ROW_PT_PX}
          mih={LISTING_ACTION_ROW_HEIGHT_PX}
          gap={LISTING_ACTION_ROW_GAP_PX}
          wrap="nowrap"
        >
          {/* Kind-aware CTA — always has a working target (a direct Open / Visit,
              or the unified detail). External Visit → new-tab anchor; everything
              else → an internal Link.

              🔴 IT FILLS THE ROW RATHER THAN STEPPING UP THE SIZE SCALE. The ask
              was a bigger primary action; the next Mantine size (`md`) is 42px
              tall, and this row's height is load-bearing (see the row note
              above), so the only free axis is horizontal. `flexGrow: 1` on the
              button — now a DIRECT child of the row — takes every pixel the `⋮`
              trigger and the row gap do not need, i.e.
              `cta = row − LISTING_ACTION_ROW_CONTROL_PX − LISTING_ACTION_ROW_GAP_PX`
              when a menu renders and the whole row when one does not. Asserted at
              two container widths, because one measurement is not a general
              claim.

              🔴 SHRINK IS LEFT AT ITS DEFAULT, deliberately, and that is a CHANGE.
              The old cluster carried `flexShrink: 0` so the rollup would absorb
              every deficit; the documented cost was that below ~218px of container
              the row OVERFLOWED the card instead. With the rollup gone the CTA is
              the only thing that can give, so letting it shrink (with `minWidth: 0`
              so the label clips rather than propping the box open) keeps the `⋮`
              inside the card at widths no store surface produces anyway — the
              narrowest real one is 248, comfortably above the ~184 natural.

              ICONS (product-feedback pass). Each action carries its own glyph so
              the three CTAs are distinguishable at a glance in a dense grid
              rather than three same-shaped buttons differing only in wording.
              🔴 The mapping itself is NOT restated here — it lives in
              `appListingActionGlyph.ts` and is read above via `CtaGlyph`. A copy
              of it in this comment is exactly how the card and the detail page
              drifted apart in the first place. The rail tile's icon button used
              to carry a third copy (`RECENT_ACTION_ICONS` in
              `RecentlyOpenedApps.tsx`); it now resolves through the same module
              via `recentRailActionGlyph`, so all three surfaces are single-
              sourced and the consolidation is complete.

              🔴 The icon is DECORATIVE — the label text stays the accessible
              name. Tabler icons render `<svg>` with no `<title>`, so they
              contribute nothing to the name; the button's name is still
              exactly "Open" / "Visit" / "View details". Asserted in
              `AppListingCard.browser.test.tsx`. */}
          {cta.external ? (
            <Button
              component="a"
              href={cta.href}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="light"
              style={{ flexGrow: 1, minWidth: 0 }}
              rightSection={<CtaGlyph size={16} />}
              // "Opened" = actually opened. An OFF-SITE app is opened the
              // moment this Visit CTA is followed — there is no on-platform
              // route afterwards that could record it (the on-site path is
              // recorded by `/apps/run/<slug>` itself). Recording on a detail
              // VIEW would be wrong: browsing is not opening.
              // 🔴 Stamped with the viewer's account id (#4048) — recents are
              // per-account, not per browser profile.
              onClick={() =>
                recordRecentlyOpenedApp(toRecentAppFromListing(card), currentUser?.id ?? null)
              }
            >
              {cta.label}
            </Button>
          ) : (
            <Button
              component={Link}
              href={cta.href}
              size="sm"
              variant={cta.action === 'open' ? 'filled' : 'light'}
              style={{ flexGrow: 1, minWidth: 0 }}
              leftSection={<CtaGlyph size={16} />}
            >
              {cta.label}
            </Button>
          )}

          {/* The `⋮` overflow menu — owner Edit, review, report, moderator
              actions. SHARED with the listing detail body; see
              `AppListingActionsMenu`.

              🔴 IT REPLACED A DUAL EDIT APPARATUS AND A WHOLE BREAKPOINT. The
              card used to carry BOTH a text `Button` ("Edit") and an icon-only
              `ActionIcon`, with an `@[360px]` container query choosing between
              them — a query that existed for no other reason. A `⋮` trigger is a
              fixed 36px at every width, so that query had nothing left to decide
              and is DELETED rather than kept as a constant nothing needs.

              🔴 `triggerSize` IS THE ROW-HEIGHT CONTRACT, not a style choice —
              it is `LISTING_ACTION_ROW_CONTROL_PX`, the SAME 36 the derived row
              height is built from and the same height the `sm` CTA button
              renders at. Passing a literal here is how the row and its own
              height constant would come apart. `variant="default"` matches the
              control it replaced.

              🔴 `stopPropagation` covers the trigger AND the dropdown. Every
              other action on this card stops propagation because the card is a
              click target; a portalled dropdown still propagates along the REACT
              tree, so opening the menu would otherwise navigate the card.

              🔴 THE CARD DOES NOT OFFER THE VIEWER ACTIONS — `surface="card"`,
              and `appListingMenuSurface.ts` owns that decision. Review and
              Report stay on the listing DETAIL page, where the viewer has
              chosen to look at one app; on a grid of ~24 tiles they are an
              invitation to review something nobody opened. The narrowing is
              declared by NAMING the surface, not by re-deriving a predicate
              here — re-deriving one is precisely the drift the shared module
              exists to prevent.

              🔴 GEOMETRY CONSEQUENCE, RESTATED BECAUSE IT SHRANK. The menu's
              predicate is still "would it hold at least one item", not "is the
              viewer the owner", so the population that gets a `⋮` is exactly
              {owner, moderator}. What that costs has changed: it used to widen
              the action cluster from 137.9 to 184 and thereby decide whether the
              recommend rollup fit at all. With the rollup out of this row the
              trigger's only consequence is that the CTA is 46px narrower
              (`LISTING_ACTION_ROW_CONTROL_PX` + `LISTING_ACTION_ROW_GAP_PX`);
              the row height and every other card's geometry are untouched. That
              equality is still pinned in `AppListingCard.browser.test.tsx` by
              running one assertion body over both viewers. */}
          <AppListingActionsMenu
            listing={menuTarget}
            surface="card"
            preview={preview}
            triggerSize={LISTING_ACTION_ROW_CONTROL_PX}
            triggerVariant="default"
            triggerIconSize={16}
            triggerTestId="apps-listing-card-actions-menu"
            triggerTooltip
            stopPropagation
          />
        </Group>
      </Stack>
    </Card>
  );
}
