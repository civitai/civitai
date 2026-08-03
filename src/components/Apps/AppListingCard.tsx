import {
  ActionIcon,
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
import { IconApps, IconPencil, IconThumbUp } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { CATEGORY_ICONS, FALLBACK_CATEGORY_ICON } from '~/components/Apps/marketplaceCategoryIcons';
import {
  canOwnerEditListing,
  getListingCta,
  getListingDetailHref,
  getOwnerEditHref,
  getRecommendLabel,
} from '~/components/Apps/appListingCardView';
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
 * + name + tagline + creator chip + a kind badge (App / Connect app / Off-site)
 * + the Steam-style recommend rollup + a kind-aware CTA (Open / View details /
 * Visit ↗ / Connect). Mirrors the visual language of the live `AppBlockCard`
 * (Mantine Card + category-glyph cover placeholder) so listings feel native.
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
}

export function AppListingCard({ card, canOpenPage = false }: AppListingCardProps) {
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

  // Owner "Edit" deep-link (Item 2). The public store DTO is approved-only + has
  // no status field, so gating is owner + editable-status (status omitted →
  // editable); the href builder returns null when there's no editable target
  // (an on-site listing with no backing appBlockId) → the button is hidden.
  const isOwner = !!currentUser?.id && currentUser.id === card.creator?.id;
  const editHref = getOwnerEditHref(card.kindData, card.id);
  const showEdit = canOwnerEditListing({ isOwner }) && !!editHref;

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

  // `@container` makes THIS card the query basis for the owner-Edit breakpoint in
  // the action row below (see the long note there). It is
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

        {/* Feedback #2: the action row's buttons stepped up a notch on the Mantine
            size scale (xs → sm), so the primary CTA reads as the card's call to
            action rather than a footnote.
            🔴 The row deliberately stays `nowrap`. Letting it wrap looks like the
            obvious way to stop the taller buttons overflowing a narrow column, but
            it breaks two things: (1) under `justify="space-between"` a wrapped line
            holding a single item sits at flex-START, so the actions would jump from
            right-aligned to LEFT-aligned; and (2) an OWNER card (Edit + CTA) wraps
            at a wider column than a non-owner card, so inside a `h-full` grid row
            one owner card would grow the height of the whole row. Instead the
            actions never shrink and the recommend rollup absorbs the pressure by
            truncating — so every card in a row keeps the same geometry regardless
            of who is looking at it. */}
        <Group justify="space-between" mt="auto" pt="xs" gap="xs" wrap="nowrap">
          {/* Recommend rollup — "N% recommend (M)" or "No reviews yet". This is the
              flexible side: it may truncate so the actions never do. */}
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            <IconThumbUp
              size={13}
              style={{ flexShrink: 0 }}
              className={card.recommend.recommendPct == null ? 'text-gray-500' : 'text-green-500'}
            />
            <Text size="xs" c="dimmed" truncate>
              {recommendLabel}
            </Text>
          </Group>

          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            {/* Owner-only "Edit" deep-link — subtle secondary action, gated by
                owner + editable status (mod-removed listings hide it). Routes by
                kind (manifest editor for on-site, submit editor for off-site).

                🔴 TWO FORMS, ONE CHOSEN BY A CONTAINER QUERY. Measured at a 280px
                card content box — what a 1200px viewport produces at the store's
                4-column `xl` grid:

                  | case @280                  | actions | rollup | rollup text |
                  |----------------------------|---------|--------|-------------|
                  | non-owner + "Open"         |      94 |    139 |         122 |
                  | non-owner + "View details" |     138 |    132 |         115 |
                  | owner + "Open"             |     188 |     82 |          65 |
                  | owner + "View details"     |     232 |     38 |          21 |

                The rollup's natural width is 139. In the last row the CTA icons'
                ~44px pushed it to 38 and "91% recommend (100)" — glyph included —
                simply vanished. Collapsing the OWNER-ONLY Edit to an icon returns
                ~50px, which is the difference between truncated and absent.

                🔴 A CONTAINER query, not a media query: the card's width is NOT
                monotonic in viewport width. At `base` the grid is ONE column, so a
                390px phone gives a WIDER card (~356) than a 1200px laptop at four
                columns (280). A `max-width` media query would collapse the button
                on exactly the viewports where there is the most room. `@container`
                asks the only question that matters — how wide is THIS card.

                Breakpoint 360px, read off the table: the owner "View details" cell
                is the binding one, and its rollup clears ~120px (legible, merely
                truncated) at container widths from ~360 up. Below that the text
                button is what breaks it, so below that it becomes an icon.

                🔴 The row stays `nowrap` with `flexShrink: 0`. Row height is a
                constant 46px in every cell above and nothing overflows — letting
                the row wrap would left-align the actions and grow the height of a
                whole `h-full` grid row (see the block comment above). The fix is
                to make the optional control smaller, not to change the layout. */}
            {showEdit && editHref && (
              <>
                <Button
                  component={Link}
                  href={editHref}
                  size="sm"
                  variant="default"
                  leftSection={<IconPencil size={16} />}
                  data-testid="apps-listing-owner-edit"
                  className="hidden @[360px]:flex"
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                >
                  Edit
                </Button>
                {/* The narrow form. Icon-only, so it needs a REAL accessible name
                    — `aria-label` + `Tooltip`, the `CategoryFilterButtons`
                    precedent ("the icon alone is not an accessible name"). Only
                    ONE of the two is ever displayed, and `display: none` removes
                    the other from the accessibility tree, so a screen reader is
                    offered exactly one "Edit" control, not two. */}
                <Tooltip label="Edit" withArrow>
                  <ActionIcon
                    component={Link}
                    href={editHref}
                    size={36}
                    variant="default"
                    aria-label="Edit"
                    data-testid="apps-listing-owner-edit-icon"
                    className="@[360px]:hidden"
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    <IconPencil size={16} />
                  </ActionIcon>
                </Tooltip>
              </>
            )}

            {/* Kind-aware CTA — always has a working target (a direct Open / Visit,
                or the unified detail). External Visit → new-tab anchor; everything
                else → an internal Link.

                ICONS (product-feedback pass). Each action carries its own glyph so
                the three CTAs are distinguishable at a glance in a dense grid
                rather than three same-shaped buttons differing only in wording.
                🔴 The mapping itself is NOT restated here — it lives in
                `appListingActionGlyph.ts` and is read above via `CtaGlyph`. A copy
                of it in this comment is exactly how the card and the detail page
                drifted apart in the first place. The rail tile's icon button still
                carries its own copy (`RECENT_ACTION_ICONS` in
                `RecentlyOpenedApps.tsx`, driven by `getRecentRailAction`); folding
                that third one in is the remaining consolidation.

                🔴 The icon is DECORATIVE — the label text stays the accessible
                name. Tabler icons render `<svg>` with no `<title>`, so they
                contribute nothing to the name; the button's name is still
                exactly "Open" / "Visit" / "View details". Asserted in
                `AppListingCard.browser.test.tsx`.

                🔴 WIDTH: `leftSection` makes each button ~22px wider, and the row
                is `wrap="nowrap"` with `flexShrink: 0` on the actions (see the
                block comment above — wrapping breaks alignment AND row height).
                The pressure is absorbed where it was designed to be: the
                recommend rollup on the left is the flexible side and truncates.
                The tight case is `md`/`lg` (3–4 columns), not `base` (one wide
                column); verified at 390/768/1440/2560 in the PR's viewport sweep. */}
            {cta.external ? (
              <Button
                component="a"
                href={cta.href}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
                variant="light"
                rightSection={<CtaGlyph size={16} />}
                // "Opened" = actually opened. An OFF-SITE app is opened the
                // moment this Visit CTA is followed — there is no on-platform
                // route afterwards that could record it (the on-site path is
                // recorded by `/apps/run/<slug>` itself). Recording on a detail
                // VIEW would be wrong: browsing is not opening.
                onClick={() => recordRecentlyOpenedApp(toRecentAppFromListing(card))}
              >
                {cta.label}
              </Button>
            ) : (
              <Button
                component={Link}
                href={cta.href}
                size="sm"
                variant={cta.action === 'open' ? 'filled' : 'light'}
                leftSection={<CtaGlyph size={16} />}
              >
                {cta.label}
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
