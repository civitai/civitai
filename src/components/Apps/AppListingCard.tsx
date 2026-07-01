import { Anchor, Avatar, Badge, Box, Button, Card, Group, Image, Stack, Text, Title } from '@mantine/core';
import {
  IconApps,
  IconExternalLink,
  IconPlugConnected,
  IconThumbUp,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORY_ICON,
} from '~/components/Apps/marketplaceCategoryIcons';
import {
  getListingBadge,
  getListingCta,
  getListingDetailHref,
  getRecommendLabel,
  type ListingBadgeKind,
} from '~/components/Apps/appListingCardView';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORY_LABELS,
} from '~/server/services/blocks/marketplace-categories.constants';
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
 * DARK / parallel-run: used only by the mod-only `/apps/store-preview` surface —
 * the default `/apps` render (MarketplaceBody → AppBlockCard) is untouched.
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

const KIND_BADGE_ICON: Record<ListingBadgeKind, Icon> = {
  onsite: IconApps,
  connect: IconPlugConnected,
  'external-link': IconExternalLink,
};

const KIND_BADGE_COLOR: Record<ListingBadgeKind, string> = {
  onsite: 'blue',
  connect: 'teal',
  'external-link': 'blue',
};

function categoryLabel(category: string): string {
  return isMarketplaceCategory(category) ? MARKETPLACE_CATEGORY_LABELS[category] : category;
}

function categoryIcon(category: string): Icon {
  return isMarketplaceCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

/**
 * Card cover — the listing's cover image (`coverUrl`, already a CDN URL, with the
 * first screenshot as a server-side fallback). When absent, a tasteful
 * category-glyph placeholder over a neutral gradient (mirrors AppBlockCard) so a
 * card is never a broken/empty `<img>`. Decorative (aria-hidden) — the placeholder
 * carries no info the title/category chip don't.
 */
function ListingCover({
  coverUrl,
  category,
  name,
}: {
  coverUrl: string | null;
  category: string | null;
  name: string;
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
  return (
    <Card.Section>
      <Box
        aria-hidden
        h={140}
        className="flex items-center justify-center"
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-dark-5) 0%, var(--mantine-color-dark-7) 100%)',
        }}
      >
        <PlaceholderIcon size={44} className="opacity-40" />
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
      onClick={(e) => e.stopPropagation()}
    >
      <Group gap={6} wrap="nowrap">
        <Avatar src={avatarSrc} alt="" radius="xl" size={20}>
          {creator.username.charAt(0).toUpperCase()}
        </Avatar>
        <Text size="xs" c="dimmed" lineClamp={1}>
          by {creator.username}
        </Text>
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
  const badge = getListingBadge(card);
  const cta = getListingCta(card, { canOpenPage });
  const detailHref = getListingDetailHref(card.slug);
  const recommendLabel = getRecommendLabel(card.recommend, card.reviewCount);
  const BadgeIcon = KIND_BADGE_ICON[badge.kind];

  return (
    <Card shadow="sm" padding="md" radius="md" withBorder className="h-full">
      <ListingCover coverUrl={card.coverUrl} category={card.category} name={card.name} />
      <Stack gap="sm" h="100%" pt="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
            {/* App icon (square, publisher-supplied). Decorative — the title
                carries the accessible name; a missing icon falls back to the
                app's initial. */}
            <Avatar src={card.iconUrl ?? undefined} alt="" radius="md" size={40}>
              {card.name.charAt(0).toUpperCase()}
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
            </Stack>
          </Group>
          <Stack gap={4} align="flex-end">
            {/* Kind badge — App (on-site) vs Connect app / Off-site (off-site). */}
            <Badge
              variant="light"
              color={KIND_BADGE_COLOR[badge.kind]}
              size="sm"
              leftSection={<BadgeIcon size={12} />}
            >
              {badge.label}
            </Badge>
            {card.category && (() => {
              const CategoryIcon = categoryIcon(card.category);
              return (
                <Badge
                  variant="light"
                  color="grape"
                  size="sm"
                  leftSection={<CategoryIcon size={12} />}
                >
                  {categoryLabel(card.category)}
                </Badge>
              );
            })()}
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
      </Stack>
    </Card>
  );
}
