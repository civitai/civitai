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
  LISTING_ROLLUP_MIN_WIDTH_PX,
  getListingCta,
  getListingDetailHref,
  getRecommendLabel,
} from '~/components/Apps/appListingCardView';
import {
  AppListingActionsMenu,
  useAppListingActionsMenuVisible,
} from '~/components/Apps/AppListingActionsMenu';
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
          aspectRatio: '16 / 9',
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
  // Whether the trigger occupies the action row. Read from the shared predicate
  // rather than re-derived — see its comment.
  const hasMenu = useAppListingActionsMenuVisible(menuTarget, preview);

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

  // `@container` makes THIS card the query basis for the recommend-rollup floor
  // breakpoint in the action row below (see the long note there). It is
  // `container-type: inline-size`, i.e. inline-axis containment only, so the
  // card's height still follows its content and `h-full` is unaffected.
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
    <Card padding="md" radius={0} className="h-full rounded-md @container">
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
            size={40}
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
                  (S13) stays out of scope. */}
              <Text size="xl" fw={700} lh={1.2} c="white" className="line-clamp-2">
                {card.name}
              </Text>
            </Anchor>
            <CreatorChip creator={card.creator} />
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

            🔴 The row deliberately stays `nowrap`. Letting it wrap looks like the
            obvious way to stop the taller buttons overflowing a narrow column, but
            it breaks two things: (1) under `justify="space-between"` a wrapped line
            holding a single item sits at flex-START, so the actions would jump from
            right-aligned to LEFT-aligned; and (2) a card WITH a `⋮` menu wraps at a
            wider column than one without, so inside a `h-full` grid row one such
            card would grow the height of the whole row. Instead the actions never
            shrink and the recommend rollup absorbs the pressure — down to a floor.

            🔴 ROW HEIGHT IS A CONSTANT 46px AND MUST STAY ONE. `pt="xs"` (10px) +
            a 36px control. Every control in the row is 36px: the `sm` CTA button
            and the `size={36}` menu trigger. The row lives in an `h-full` grid
            row, so a taller control here propagates to every card in that row
            across the whole store — which is why the CTA grows HORIZONTALLY
            rather than up the size scale. Re-measured after this change at
            container 248 / 282 / 462: 46px in every cell. */}
        <Group justify="space-between" mt="auto" pt="xs" gap="xs" wrap="nowrap">
          {/* Recommend rollup — "N% recommend (M)" or "No reviews yet". This is the
              flexible side: it may truncate so the actions never do.

              🔴 …but ONLY DOWN TO A FLOOR, AND THE FLOOR IS NOW ENFORCED. It used
              to be `minWidth: 0` — "shrink to nothing" — with the floor existing
              only as the arithmetic behind the container query below. That was
              survivable while nothing competed for the free space. It is not
              survivable now that the CTA GROWS into it: a `flex-grow` on the CTA
              with a zero-floor rollup starves the rollup at EVERY width, not just
              the narrow ones the query was built for — i.e. the obvious
              implementation of "make the CTA fill the row" destroys the exact
              thing the query exists to protect. So the floor is stated as a
              constraint the layout engine enforces (`minWidth:
              LISTING_ROLLUP_MIN_WIDTH_PX`), and the CTA takes only the remainder.

              🔴 THE TABLE BELOW WAS RE-MEASURED ON THIS BRANCH — it is not the
              pre-change one carried forward. A card WITH a menu, the widest CTA
              ("View details"), no reviews (the SHORTEST label the rollup can
              carry, so a deficit here is structural rather than an artefact of a
              long string). Widths are `getBoundingClientRect`:

                | card | container | actions nat/rendered | rollup | row h | rollup    |
                |------|-----------|----------------------|--------|-------|-----------|
                |  280 |       248 | 184 /  248 (grown)   |    0   |    46 | HIDDEN    |
                |  296 |       264 | 184 /  184           |   70.1 |    46 | at FLOOR  |
                |  314 |       282 | 184 /  184           |   88.1 |    46 | clamped   |
                |  494 |       462 | 184 /  356.3 (grown) |   95.7 |    46 | natural   |

              Two columns for the actions because they are now two different
              numbers: 184 is the cluster's NATURAL width (36px `⋮` + 10px gap +
              137.9px CTA), which is what the threshold arithmetic below is built
              from; the RENDERED width is larger wherever the row has free space
              for the CTA to grow into. In the two middle rows the row is in
              DEFICIT, so there is no growth and the two coincide.

              The 264 row is the one that matters: 70.1px is
              `LISTING_ROLLUP_MIN_WIDTH_PX` doing work, not a coincidence of the
              content. The same card at 462 leaves the rollup at its natural 95.7
              and gives the CTA the other 260 — which is the whole point of the
              change: the CTA grows into the slack, it does not eat the floor.

              ⚠️ A CORNER THIS CREATES, on the record: an enforced floor means a
              row can OVERFLOW instead of crushing the rollup. A card with no menu
              needs 137.9 + 10 + 70 = 218px of container to hold both; measured at
              a synthetic 168px container the row's `scrollWidth` is 218 against a
              `clientWidth` of 168. No store surface produces that — the 4-column
              `lg` grid bottoms out at 248, the `base` grid is one wide column, and
              the moderator preview card is capped at 340 (308 content) — and a
              card WITH a menu already overflowed at that width before this change
              (its 184px cluster alone exceeds 168). Pinned at 248, the narrowest
              width the store can actually produce, rather than left to prose.

              🔴 THRESHOLD 264px, DERIVED NOT GUESSED, AND NOW MACHINE-CHECKED.
              `LISTING_ROLLUP_HIDE_BELOW_PX` in `appListingCardView.ts` computes
              it as actions(184) + row gap(10) + floor(70) = 264, and
              `__tests__/appListingCardView.test.ts` asserts this file's
              `@[264px]` class spells the same number — a Tailwind arbitrary
              variant cannot read a JS constant, so the duplication is
              unavoidable and the drift is what gets gated instead.

              The 184 is MEASURED, not modelled: a 36px `⋮` trigger + the row's
              10px `gap="xs"` + the widest CTA at its natural 138px. It happens to
              equal the pre-change value, because the control the menu replaced was
              an icon-only Edit `ActionIcon` at the same `size={36}` — worth naming,
              because "the number did not move" is also what a measurement nobody
              took looks like.

              🔴 A CONTAINER query, not a media query: card width is NOT monotonic
              in viewport width (at `base` the grid is ONE column, so a 390px phone
              gives a ~356px card — wider than the 280px a 1200px laptop gets at
              four columns). A `max-width` media query would hide the rollup on
              exactly the viewports with the most room.

              🔴 GATED ON `hasMenu`, NOT ON OWNERSHIP. It used to be `showEdit`,
              because the Edit button was the only thing that widened the row.
              The `⋮` trigger is now that thing, and it appears for anyone the menu
              has an item for. A card with NO menu keeps its 138px action cluster
              and its rollup never approaches the floor at any width the store
              produces — byte-unchanged, and pinned as such.

              ⚠️ ACCEPTED COLLATERAL, on the record rather than discovered later:
              the query cannot see WHICH CTA rendered, so a card whose CTA is the
              narrow "Open" loses a rollup that would have fit, across container
              248–264. Encoding a second per-CTA threshold buys a second magic
              number and a CTA-width classification in the render path; one rule
              that is occasionally conservative is the better trade. */}
          <Group
            gap={4}
            wrap="nowrap"
            style={{ minWidth: LISTING_ROLLUP_MIN_WIDTH_PX }}
            className={hasMenu ? 'hidden @[264px]:flex' : undefined}
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

          {/* 🔴 `flexGrow: 1` IS WHAT MAKES THE CTA FILL THE ROW, and it is on the
              CLUSTER rather than on the button alone because the button is not a
              direct child of the row — the `⋮` trigger shares the cluster with it.
              The cluster grows, the fixed-width trigger does not, so the whole
              remainder lands on the CTA (which carries its own `flexGrow: 1`).

              🔴 `flexShrink: 0` STAYS. Growth and shrink are independent here and
              only growth is wanted: the actions are the rigid side, and the rollup
              — clamped at its floor — is the side that gives. Below the container
              query's threshold the rollup leaves layout entirely rather than the
              actions being squeezed.

              🔴 `marginLeft: 'auto'` is RETAINED THOUGH NOW REDUNDANT, deliberately.
              With `flexGrow: 1` the cluster already reaches the row's right edge, so
              the auto margin currently absorbs zero free space (flexible lengths are
              resolved BEFORE auto margins). It stays because it is the thing that
              keeps the actions right-aligned if the grow is ever removed: under
              `justify="space-between"` a SINGLE remaining flex item sits at
              flex-START, so with the rollup hidden and no grow and no auto margin,
              the whole CTA cluster jumps to the card's left edge. Two independent
              mechanisms for one invariant, both cheap. */}
          <Group
            gap="xs"
            wrap="nowrap"
            style={{ flexShrink: 0, flexGrow: 1, minWidth: 0, marginLeft: 'auto' }}
          >
            {/* Kind-aware CTA — always has a working target (a direct Open / Visit,
                or the unified detail). External Visit → new-tab anchor; everything
                else → an internal Link.

                🔴 IT FILLS THE ROW RATHER THAN STEPPING UP THE SIZE SCALE. The ask
                was a bigger primary action; the next Mantine size (`md`) is 42px
                tall, and this row's height is load-bearing (see the row note
                above), so the only free axis is horizontal. `flexGrow: 1` inside a
                cluster that itself grows gives the CTA every pixel the rollup's
                floor and the `⋮` trigger do not need.

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
                style={{ flexGrow: 1 }}
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
                style={{ flexGrow: 1 }}
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

                🔴 `size={36}` IS THE ROW-HEIGHT CONTRACT, not a style choice — it
                matches the `sm` CTA button exactly, which is what keeps the row at
                46px (see the row note above). `variant="default"` matches the
                control it replaced.

                🔴 `stopPropagation` covers the trigger AND the dropdown. Every
                other action on this card stops propagation because the card is a
                click target; a portalled dropdown still propagates along the REACT
                tree, so opening the menu would otherwise navigate the card.

                🔴 GEOMETRY CONSEQUENCE, ACCEPTED AND STATED: the menu's predicate
                is "would it hold at least one item", not "is the viewer the
                owner". So a MODERATOR viewing someone else's card gets a `⋮` and
                therefore a different action-row geometry from an anonymous
                shopper. That is the same predicate the detail page has always
                applied, and re-deriving a narrower one here is precisely the
                drift this shared module exists to prevent. */}
            <AppListingActionsMenu
              listing={menuTarget}
              preview={preview}
              triggerSize={36}
              triggerVariant="default"
              triggerIconSize={16}
              triggerTestId="apps-listing-card-actions-menu"
              triggerTooltip
              stopPropagation
            />
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
