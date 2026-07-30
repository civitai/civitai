import { Anchor, Avatar, Badge, Box, Button, Card, Group, Image, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconApps, IconExternalLink, IconPencil, IconThumbUp } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORY_ICON,
} from '~/components/Apps/marketplaceCategoryIcons';
import {
  canOwnerEditListing,
  getListingCta,
  getListingDetailHref,
  getOwnerEditHref,
  getRecommendLabel,
} from '~/components/Apps/appListingCardView';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
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
  if (coverUrl && !broken) {
    return (
      <Card.Section>
        <Image
          src={coverUrl}
          alt={`${name} cover image`}
          h={140}
          fit="cover"
          onError={() => setBroken(true)}
        />
      </Card.Section>
    );
  }
  const PlaceholderIcon = category ? categoryIcon(category) : IconApps;
  // Per-app SEEDED gradient (not one uniform grey for every coverless listing) —
  // same seed + stops the generated cover SVG uses, so a listing that later gets
  // a real generated asset keeps its colour identity. See
  // `~/shared/constants/app-listing-placeholder.constants`.
  return (
    <Card.Section>
      <Box
        aria-hidden
        h={140}
        className="flex items-center justify-center"
        data-listing-cover-placeholder=""
        style={{ background: listingPlaceholderGradient({ slug, category, surface: 'cover' }) }}
      >
        <PlaceholderIcon size={44} className="opacity-60" />
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
        <TruncatedText
          size="xs"
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

  return (
    <Card shadow="sm" padding="md" radius="md" withBorder className="h-full">
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
              <Title order={4} className="line-clamp-2">
                {card.name}
              </Title>
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

        <Group justify="space-between" mt="auto" pt="xs" wrap="nowrap">
          {/* Recommend rollup — "N% recommend (M)" or "No reviews yet". */}
          <Group gap={4} wrap="nowrap">
            <IconThumbUp
              size={13}
              className={card.recommend.recommendPct == null ? 'text-gray-500' : 'text-green-500'}
            />
            <Text size="xs" c="dimmed">
              {recommendLabel}
            </Text>
          </Group>

          <Group gap={6} wrap="nowrap">
            {/* Owner-only "Edit" deep-link — subtle secondary action, gated by
                owner + editable status (mod-removed listings hide it). Routes by
                kind (manifest editor for on-site, submit editor for off-site). */}
            {showEdit && editHref && (
              <Button
                component={Link}
                href={editHref}
                size="xs"
                variant="default"
                leftSection={<IconPencil size={14} />}
                data-testid="apps-listing-owner-edit"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                Edit
              </Button>
            )}

            {/* Kind-aware CTA — always has a working target (a direct Open / Visit,
                or the unified detail). External Visit → new-tab anchor; everything
                else → an internal Link. */}
            {cta.external ? (
              <Button
                component="a"
                href={cta.href}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                variant="light"
                rightSection={<IconExternalLink size={14} />}
              >
                {cta.label}
              </Button>
            ) : (
              <Button
                component={Link}
                href={cta.href}
                size="xs"
                variant={cta.action === 'open' ? 'filled' : 'light'}
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
