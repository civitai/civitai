import {
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Image,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconApps, IconEyeOff, IconPlayerPlay, IconThumbUp } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { CATEGORY_ICONS, FALLBACK_CATEGORY_ICON } from '~/components/Apps/marketplaceCategoryIcons';
import {
  getListingCta,
  getListingDetailHref,
  getPlayCountLabel,
  getRecommendLabel,
} from '~/components/Apps/appListingCardView';
import {
  LISTING_CARD_COVER_ASPECT_RATIO,
  LISTING_CARD_CREATOR_AVATAR_PX,
  LISTING_CARD_CTA_HEIGHT_PX,
  LISTING_CARD_FOOTER_HEIGHT_PX,
  LISTING_CARD_HEADER_CENTER_PX,
  LISTING_CARD_ICON_OVERLAP_PX,
  LISTING_CARD_ICON_SIZE_PX,
  LISTING_CARD_MENU_TRIGGER_PX,
  LISTING_CARD_TITLE_FONT_PX,
  LISTING_CARD_TITLE_LINE_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
import { AppListingActionsMenu } from '~/components/Apps/AppListingActionsMenu';
import { ACTION_GLYPH_ICONS, cardActionGlyph } from '~/components/Apps/appListingActionGlyph';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { visibilityBadgeFor } from '~/components/Apps/listingVisibilityCopy';
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
 * App Store Listings (W13) — the unified store CARD, over BOTH kinds.
 *
 * Renders one `ListingCard` (from `appListings.listAvailable`) as card A: a cover with
 * the `⋮` menu over its top-right; a header row of the app icon (straddling the cover's
 * bottom edge), a one-line title and the kind-aware CTA (Open / View details / Visit ↗),
 * the title and CTA centred on the icon's centre; badges and the tagline; and, under a
 * divider, a footer with the recommend rollup and play count on the left and the creator on
 * the right. The whole card is one click target: the title link is stretched over it
 * (`after:inset-0`) and every other control sits above that layer (`relative z-10`).
 *
 * A creator without a username renders no byline link. The detail page uses `CreatorChip`.
 *
 * 🔴 THE CARD'S GEOMETRY IS NOT SPELLED HERE — it is READ from `appListingCardGeometry.ts`
 * (cover ratio, icon size and overlap, title font and line-height, CTA/menu/footer/avatar
 * sizes). `AppListingCardSkeleton` must reserve EXACTLY this geometry or the grid reflows
 * when the query resolves. `__tests__/appListingCardView.test.ts` requires the card to read
 * every export (the skeleton is checked separately). Do not re-literalise a value below.
 *
 * 🔴 THE PLAY COUNT RENDERS ONLY FOR A COUNT OF ONE OR MORE. Both `openCount === null`
 * (off-site, unmeasurable) and `0` (measured, empty) render nothing: an OPERATOR OVERRIDE
 * (2026-09-06, "dont show 0 plays"). The DTO keeps them apart (see `cardOpenCount`); the
 * rule is in `getPlayCountLabel`, not here.
 *
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
export function ListingCover({
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
  // 🔴 THE NULL-VS-ZERO DECISION IS **NOT** MADE HERE — `getPlayCountLabel` owns it
  // and returns `null` for an unmeasurable listing. That is deliberate: this
  // component is covered only by the browser project, while the pure view-model is
  // covered by the node `unit` project. A
  // `card.openCount != null && …` written into the JSX below would put the rule
  // out of reach of the node tier. All this line does is carry the
  // answer to the render, and all the render does is omit a `null`.
  const playCountLabel = getPlayCountLabel(card.openCount);

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
  const visibilityBadge = visibilityBadgeFor(card.restrictedAudience);

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
  // Losing the border is safe at 1-per-row mobile, where the card is effectively
  // full-bleed: the card's own fill (rgb(37,38,43)) separates it from the page
  // (rgb(26,27,30)) with every ancestor transparent — the same separation `/models`
  // already relies on at `border: 0`. Measured, not assumed.
  // The whole card is one click target: the title link is stretched over it (`after:inset-0`),
  // and every other control (Open, `⋮`, creator link) sits above that layer (`relative z-10`).
  const creator = card.creator;
  return (
    <Card padding={0} radius={0} className="h-full rounded-md">
      <ListingCover
        coverUrl={card.coverUrl}
        category={card.category}
        name={card.name}
        slug={card.slug}
      />
      {/* `⋮` menu over the cover's top-right corner, like the image cards. The trigger is
          the `⋮` icon on a translucent disc so it reads over any cover art. */}
      <div className="absolute right-2 top-2 z-10" data-testid="apps-listing-card-menu-slot">
        <AppListingActionsMenu
          listing={menuTarget}
          surface="card"
          preview={preview}
          triggerSize={LISTING_CARD_MENU_TRIGGER_PX}
          triggerVariant="default"
          triggerIconSize={16}
          triggerTestId="apps-listing-card-actions-menu"
          triggerTooltip
          stopPropagation
        />
      </div>
      <Stack gap="xs" h="100%" px="md" pb="sm">
        {/* HEADER ROW: icon (overlapping the cover), title, Open. The icon is pulled up over the
            cover by `LISTING_CARD_ICON_OVERLAP_PX`; the title and the button are centred on the
            ICON's centre, not the row's, which is why they carry their own top margin. */}
        <Group
          gap="sm"
          wrap="nowrap"
          align="flex-start"
          style={{ minWidth: 0 }}
          data-testid="apps-listing-card-header"
        >
          {/* App icon (square, publisher-supplied). Decorative — the title carries the
              accessible name; a missing icon falls back to the app's initial. */}
          <Avatar
            src={card.iconUrl ?? undefined}
            alt=""
            radius="md"
            size={LISTING_CARD_ICON_SIZE_PX}
            style={{
              flexShrink: 0,
              marginTop: -LISTING_CARD_ICON_OVERLAP_PX,
              // A ring in the card's own fill, so the icon reads as lifted off the cover.
              boxShadow:
                '0 0 0 3px light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
            }}
            data-listing-icon-placeholder={card.iconUrl == null ? '' : undefined}
            styles={{
              // Missing icon → the SAME seeded monogram the generated icon SVG renders
              // (per-app hue + first-alphanumeric initial), instead of Mantine's flat grey.
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
          {/* Title: ONE line, ellipsized, full name in a tooltip only when it actually clips.
              Its link is the stretched card link. */}
          <Anchor
            component={Link}
            href={detailHref}
            underline="hover"
            c="inherit"
            className="after:absolute after:inset-0 after:content-['']"
            style={{
              minWidth: 0,
              flex: 1,
              marginTop:
                LISTING_CARD_HEADER_CENTER_PX -
                (LISTING_CARD_TITLE_FONT_PX * LISTING_CARD_TITLE_LINE_HEIGHT) / 2,
            }}
          >
            {/* 🔴 20px/700/#fefefe, matching the `/models` card title (`c="white"` is the token
                ThemeProvider sets to #fefefe on purpose). No `dropShadow`: this title sits on
                the card body, not over media. */}
            <TruncatedText
              size="xl"
              fw={700}
              lh={LISTING_CARD_TITLE_LINE_HEIGHT}
              c="light-dark(var(--mantine-color-dark-9), var(--mantine-color-white))"
              // Above the stretched link's `::after`, or the pointer never reaches the text
              // and the tooltip cannot open. A click here still bubbles to the link.
              className="relative z-10"
              tooltipLabel={card.name}
            >
              {card.name}
            </TruncatedText>
          </Anchor>
          {/* Kind-aware CTA — always has a working target (a direct Open / Visit, or the unified
              detail). External Visit → new-tab anchor; everything else → an internal Link. It
              stays a visible button: with the whole card clickable, the button is what says an
              app can be opened from here. The glyph mapping lives in `appListingActionGlyph.ts`
              and the icon is decorative (the label stays the accessible name). */}
          {cta.external ? (
            <Button
              component="a"
              href={cta.href}
              target="_blank"
              rel="noopener noreferrer"
              size="compact-sm"
              variant="light"
              className="relative z-10"
              style={{
                flexShrink: 0,
                marginTop: `calc(${LISTING_CARD_HEADER_CENTER_PX}px - ${
                  LISTING_CARD_CTA_HEIGHT_PX / 2
                }px)`,
              }}
              rightSection={<CtaGlyph size={14} />}
              // "Opened" = actually opened. An OFF-SITE app is opened the moment this Visit CTA is
              // followed — there is no on-platform route afterwards that could record it (the
              // on-site path is recorded by `/apps/run/<slug>` itself). Recording on a detail
              // VIEW would be wrong: browsing is not opening.
              // 🔴 Stamped with the viewer's account id (#4048) — recents are per-account.
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
              size="compact-sm"
              variant={cta.action === 'open' ? 'filled' : 'light'}
              className="relative z-10"
              style={{
                flexShrink: 0,
                marginTop: `calc(${LISTING_CARD_HEADER_CENTER_PX}px - ${
                  LISTING_CARD_CTA_HEIGHT_PX / 2
                }px)`,
              }}
              leftSection={<CtaGlyph size={14} />}
            >
              {cta.label}
            </Button>
          )}
        </Group>

        {/* ONE NON-WRAPPING ROW FOR EVERY CONDITIONAL BADGE, WHOSE LONG BADGES TRUNCATE — it never
            grows a second line. "Beta" never shrinks (short, and the whole signal); the long
            badges shrink (`flexShrink: 1` + `minWidth: 0`), and their Tooltip carries the full
            text. Rendered only when at least one badge is. */}
        {(card.isBeta || showOwnerIncomplete || visibilityBadge) && (
          <Group
            gap={4}
            wrap="nowrap"
            style={{ minWidth: 0 }}
            data-testid="apps-listing-card-badges"
          >
            {/* AUTHOR-DECLARED beta label: PUBLIC (the `Incomplete` badge is owner-only), and no
                tooltip because the card DTO carries no `betaMessage`. `card.isBeta` is `false`
                both for "not in beta" and while the manual-apply migration is outstanding. */}
            {card.isBeta && (
              <Badge
                color="violet"
                variant="light"
                size="xs"
                style={{ flexShrink: 0 }}
                data-testid="apps-listing-card-beta"
              >
                Beta
              </Badge>
            )}
            {/* RESTRICTED VISIBILITY. `restrictedAudience` is viewer-scoped by the server, so this
                only formats it — `visibilityBadgeFor` holds the label/tooltip decisions. */}
            {visibilityBadge && (
              <Tooltip label={visibilityBadge.tooltip} withArrow multiline w={220}>
                <Badge
                  color="gray"
                  variant="light"
                  size="xs"
                  leftSection={<IconEyeOff size={10} aria-hidden />}
                  style={{ cursor: 'help', flexShrink: 1, minWidth: 0 }}
                  data-testid="apps-listing-card-visibility"
                >
                  {visibilityBadge.label}
                </Badge>
              </Tooltip>
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
                  style={{ cursor: 'help', flexShrink: 1, minWidth: 0 }}
                  data-testid="apps-listing-owner-incomplete"
                >
                  Incomplete
                </Badge>
              </Tooltip>
            )}
          </Group>
        )}

        {card.tagline && (
          <Text size="sm" c="dimmed" className="line-clamp-3">
            {card.tagline}
          </Text>
        )}

        {/* ── THE FOOTER ─────────────────────────────────────────────────────
            A divider, then reviews and plays on the left and the creator on the right, bottom-
            pinned by `mt="auto"` so every card in a grid row ends at the same y.

            🔴 THE ROLLUP HALF ALWAYS RENDERS ("No reviews yet" included): dropping the line
            would make card heights depend on review state inside an `h-full` grid row, and it is
            what lets `AppListingCardSkeleton` reserve this row unconditionally.
            🔴 THE PLAY HALF RENDERS ONLY FOR A COUNT OF ONE OR MORE: `playCountLabel` is `null`
            for BOTH `openCount === null` (off-site, unmeasurable) and `0` (measured, empty), an
            OPERATOR OVERRIDE (2026-09-06, "dont show 0 plays"); the rule lives in
            `getPlayCountLabel`. `!= null`, not truthiness, because the label is a string.
            🔴 `wrap="nowrap"` is load-bearing: a wrapped footer is a second line, i.e. a card
            taller than its skeleton on every card in that grid row. The rollup and the creator
            name truncate (`minWidth: 0`); the play count is short and `flexShrink: 0`. */}
        <Divider mt="auto" />
        <Group
          gap="sm"
          wrap="nowrap"
          justify="space-between"
          mih={LISTING_CARD_FOOTER_HEIGHT_PX}
          data-testid="apps-listing-card-footer"
        >
          <Group
            gap="sm"
            wrap="nowrap"
            style={{ minWidth: 0 }}
            data-testid="apps-listing-card-stats"
          >
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
            {playCountLabel != null && (
              <Group
                gap={4}
                wrap="nowrap"
                style={{ flexShrink: 0 }}
                data-testid="apps-listing-play-count"
              >
                <IconPlayerPlay size={13} style={{ flexShrink: 0 }} className="text-gray-500" />
                <Text size="xs" c="dimmed">
                  {playCountLabel}
                </Text>
              </Group>
            )}
          </Group>
          {creator?.username && (
            <Anchor
              component={Link}
              href={`/user/${encodeURIComponent(creator.username)}`}
              underline="hover"
              c="dimmed"
              className="relative z-10"
              style={{ minWidth: 0, flexShrink: 1 }}
              data-testid="apps-listing-card-creator"
            >
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }} justify="flex-end">
                <Avatar
                  src={creator.image ?? undefined}
                  alt=""
                  size={LISTING_CARD_CREATOR_AVATAR_PX}
                  radius="xl"
                  style={{ flexShrink: 0 }}
                />
                <Text size="xs" c="dimmed" truncate>
                  {creator.username}
                </Text>
              </Group>
            </Anchor>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
