import {
  Alert,
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconApps,
  IconArrowLeft,
  IconExternalLink,
  IconInfoCircle,
  IconPencil,
  IconPlugConnected,
  IconThumbUp,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  appInitial,
  listingPlaceholderGradient,
} from '~/shared/constants/app-listing-placeholder.constants';
import { getRecommendLabel } from '~/components/Apps/appListingCardView';
import {
  canOwnerEditListing,
  getDetailPrimaryAction,
  getOwnerEditHref,
} from '~/components/Apps/appListingDetailView';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AppListingComments } from '~/components/Apps/AppListingComments';
import { ReportListingButton } from '~/components/Apps/ReportListingButton';
import { ReviewListingButton } from '~/components/Apps/ReviewListingButton';
import { AppListingReviews } from '~/components/Apps/AppListingReviews';
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORY_ICON,
} from '~/components/Apps/marketplaceCategoryIcons';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type {
  ListingDetail,
  ListingGalleryScreenshot,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2c unified listing DETAIL body (over BOTH kinds).
 *
 * Renders one `ListingDetail` (from `appListings.getAppDetail`): a hero cover +
 * app icon + name + tagline + creator chip + kind badge + Steam-style recommend
 * breakdown + a screenshot gallery + a `CustomMarkdown` description + the
 * kind-aware primary action (`getDetailPrimaryAction`). Mirrors the visual
 * language of the LIVE per-app detail (`/apps/[appBlockId]` + `AppDetailsModal`)
 * — same screenshot-grid + description + external-link discipline — so listings
 * feel native.
 *
 * DARK / parallel-run: rendered by the mod-only `/apps/store-preview/<slug>`
 * surface AND, in read-only `preview` mode (see props), by the moderator
 * listing-media review as a store preview of an unapproved shadow listing. The
 * live `/apps/[appBlockId]` detail + `AppDetailsModal` + default `/apps` are
 * byte-unchanged; the canonical `/apps/[slug]` cutover is P2d.
 *
 * XSS / encoding discipline (mirrors P2b): external hrefs are https-guarded in
 * the pure view-model (`safeExternalHref`) + rendered with rel="noopener
 * noreferrer" target="_blank"; the markdown description goes through the shared
 * `CustomMarkdown` (react-markdown, no `dangerouslySetInnerHTML`).
 *
 * Reuse tradeoffs (flagged in the PR, consistent with P2b):
 *   - Creator: `UserAvatarSimple` wants a rich `ProfileImage` + cosmetics object;
 *     the public DTO carries only a bare `{id,username,image}` string, so we
 *     render the same lightweight avatar chip the P2b card uses.
 *   - Cover: `AspectRatioImageCard` (cosmetic frames / per-image blur) needs a
 *     full `Image` object; the allowlist DTO projects only a `coverUrl` string,
 *     so we render a plain cover with the category-glyph placeholder fallback
 *     (same as the card). Feeding those would be a P2a schema addition.
 */

function categoryIcon(category: string): Icon {
  return isMarketplaceCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

/**
 * Hero cover — the listing cover (`coverUrl`, already a CDN URL). Falls back to a
 * category-glyph placeholder over a neutral gradient when absent OR the image
 * 404s (a coverUrl derived from a first-screenshot fallback can dangle) — never
 * a broken `<img>`. Decorative (aria-hidden placeholder).
 */
function HeroCover({
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
  const [broken, setBroken] = useState(false);
  if (coverUrl && !broken) {
    return (
      <Image
        src={coverUrl}
        alt={`${name} cover image`}
        h={260}
        fit="cover"
        radius="md"
        onError={() => setBroken(true)}
      />
    );
  }
  const PlaceholderIcon = category ? categoryIcon(category) : IconApps;
  // Per-app SEEDED gradient — same seed/stops as the generated cover SVG and the
  // store card, so one listing reads as one identity across every surface.
  return (
    <Box
      aria-hidden
      h={260}
      className="flex items-center justify-center"
      data-listing-cover-placeholder
      style={{
        borderRadius: 'var(--mantine-radius-md)',
        background: listingPlaceholderGradient({ slug, category, surface: 'cover' }),
      }}
    >
      <PlaceholderIcon size={72} className="opacity-60" />
    </Box>
  );
}

/**
 * "by {creator}" chip — the public creator projection ({id,username,image}).
 * Links to the creator profile. (UserAvatarSimple reuse tradeoff — see the file
 * docstring.)
 */
function CreatorChip({ creator }: { creator: ListingDetail['creator'] }) {
  if (!creator || !creator.username) return null;
  const avatarSrc = creator.image ? getEdgeUrl(creator.image, { width: 64 }) : undefined;
  return (
    <Anchor
      component={Link}
      href={`/user/${encodeURIComponent(creator.username)}`}
      underline="hover"
      c="dimmed"
    >
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <Avatar src={avatarSrc} alt="" radius="xl" size={24} style={{ flexShrink: 0 }}>
          {creator.username.charAt(0).toUpperCase()}
        </Avatar>
        {/* Tuned to fit; Tooltip reveals a long username only when it still clips. */}
        <TruncatedText
          size="sm"
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

/**
 * One screenshot tile — hides itself on load error (a dangling Image ref) rather
 * than rendering a broken `<img>`. Plain `<img>` (mirrors AppDetailsModal / the
 * live detail): the URL is a CDN edge URL, not a configured Next/Image domain.
 */
function ScreenshotTile({ shot, name, index }: { shot: ListingGalleryScreenshot; name: string; index: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <Card withBorder padding={0} radius="md" style={{ overflow: 'hidden' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shot.url}
        alt={shot.caption ? shot.caption : `${name} screenshot ${index + 1}`}
        loading="lazy"
        onError={() => setBroken(true)}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      />
      {shot.caption && (
        <Text size="xs" c="dimmed" p="xs" lineClamp={2}>
          {shot.caption}
        </Text>
      )}
    </Card>
  );
}

/** Screenshot gallery — reuses AppDetailsModal's SimpleGrid pattern. Empty/broken
 *  URLs are skipped; the whole section is hidden when nothing remains. */
function ScreenshotGallery({ screenshots, name }: { screenshots: ListingGalleryScreenshot[]; name: string }) {
  const shots = screenshots.filter((s) => !!s.url);
  if (shots.length === 0) return null;
  return (
    <>
      <Divider />
      <Stack gap="xs">
        <Title order={4}>Screenshots</Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          {shots.map((shot, i) => (
            <ScreenshotTile key={`${shot.url}-${i}`} shot={shot} name={name} index={i} />
          ))}
        </SimpleGrid>
      </Stack>
    </>
  );
}

/** Kind-aware primary action button + (for info/connect stubs) an inline note. */
function PrimaryAction({ detail, canOpenPage }: { detail: ListingDetail; canOpenPage: boolean }) {
  const action = getDetailPrimaryAction(detail, { canOpenPage });

  if (action.mode === 'open' && action.href) {
    return (
      <Button component={Link} href={action.href} leftSection={<IconExternalLink size={16} />}>
        {action.label}
      </Button>
    );
  }

  if (action.mode === 'visit' && action.href) {
    return (
      <Button
        component="a"
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        leftSection={<IconExternalLink size={16} />}
      >
        {action.label}
      </Button>
    );
  }

  if (action.mode === 'connect') {
    // Honest stub — no derivable OAuth authorize URL from the public DTO. Inert
    // button + a note so the affordance is never a dead 404 link.
    return (
      <Stack gap={4}>
        <Button variant="default" leftSection={<IconPlugConnected size={16} />} disabled>
          {action.label}
        </Button>
        {action.note && (
          <Text size="xs" c="dimmed">
            {action.note}
          </Text>
        )}
      </Stack>
    );
  }

  // Informational (`info`) — optional "learn more" internal link + a note.
  return (
    <Stack gap={4}>
      {action.href ? (
        <Button component={Link} href={action.href} variant="default" leftSection={<IconInfoCircle size={16} />}>
          {action.label}
        </Button>
      ) : (
        <Group gap={6} c="dimmed">
          <IconInfoCircle size={16} />
          <Text size="sm">{action.label}</Text>
        </Group>
      )}
      {action.note && (
        <Text size="xs" c="dimmed">
          {action.note}
        </Text>
      )}
    </Stack>
  );
}

export interface AppListingDetailBodyProps {
  detail: ListingDetail;
  /** Whether the viewer can launch an in-host page app (the `appBlocksPages` flag). */
  canOpenPage?: boolean;
  /**
   * READ-ONLY preview posture. When set, render ONLY the presentational parts —
   * hero cover, icon, name, tagline, creator chip, content-rating badge, screenshot
   * gallery, description markdown — and OMIT every LIVE/interactive surface: the
   * comments + recommend reviews, the report / review / primary-action / owner-edit
   * buttons, and the recommend roll-up. Used by the moderator listing-media review
   * to render an unapproved SHADOW listing as a store preview WITHOUT loading its
   * comments/reviews (which don't exist yet) or exposing user actions on an
   * un-approved listing. When NOT set, behaviour is byte-identical to before.
   */
  preview?: boolean;
}

export function AppListingDetailBody({
  detail,
  canOpenPage = false,
  preview = false,
}: AppListingDetailBodyProps) {
  const currentUser = useCurrentUser();
  const recommendLabel = getRecommendLabel(detail.recommend, detail.reviewCount);
  const hasRecommend = detail.recommend.recommendPct != null;

  // Owner "Edit" deep-link (Item 2) — owner + editable status (approved-only read
  // path carries no status → editable); the href builder returns null when there
  // is no editable target (on-site listing with no backing appBlockId).
  const isOwner = !!currentUser?.id && currentUser.id === detail.creator?.id;
  const editHref = getOwnerEditHref(detail.kindData, detail.id);
  const showEdit = canOwnerEditListing({ isOwner }) && !!editHref;

  return (
    <Stack gap="lg">
      {/* Back-to-store nav is a live-surface affordance — omitted in preview. */}
      {!preview && (
        <Anchor component={Link} href="/apps/store-preview" size="sm">
          <Group gap={4}>
            <IconArrowLeft size={14} />
            Back to store
          </Group>
        </Anchor>
      )}

      <HeroCover
        coverUrl={detail.coverUrl}
        category={detail.category}
        name={detail.name}
        slug={detail.slug}
      />

      {/* Header: icon + name + tagline + creator + content-rating badge + action. */}
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="md" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          <Avatar
            src={detail.iconUrl ?? undefined}
            alt=""
            radius="md"
            size={64}
            data-listing-icon-placeholder={detail.iconUrl == null ? '' : undefined}
            styles={{
              placeholder: {
                background: listingPlaceholderGradient({
                  slug: detail.slug,
                  category: detail.category,
                  surface: 'icon',
                }),
                color: 'var(--mantine-color-white)',
                fontWeight: 700,
              },
            }}
          >
            {appInitial(detail.name, detail.slug)}
          </Avatar>
          <Stack gap={6} style={{ minWidth: 0 }}>
            <Title order={2} className="line-clamp-2">
              {detail.name}
            </Title>
            {detail.tagline && (
              <Text c="dimmed" size="sm" className="line-clamp-2">
                {detail.tagline}
              </Text>
            )}
            <CreatorChip creator={detail.creator} />
            {detail.contentRating && (
              <Group gap="xs" mt={2}>
                <Badge variant="light" color="gray" size="sm">
                  {detail.contentRating}
                </Badge>
              </Group>
            )}
          </Stack>
        </Group>
        {/* Action column (primary action + owner edit + review/report) — every
            item here is a LIVE interactive affordance, so the whole column is
            omitted in read-only preview. */}
        {!preview && (
        <Box style={{ flexShrink: 0 }}>
          <Stack gap="xs" align="flex-end">
            <PrimaryAction detail={detail} canOpenPage={canOpenPage} />
            {/* Owner-only "Edit" deep-link — subtle secondary action, gated by
                owner + editable status (mod-removed listings hide it). Routes by
                kind (manifest editor for on-site, submit editor for off-site). */}
            {showEdit && editHref && (
              <Button
                component={Link}
                href={editHref}
                variant="default"
                leftSection={<IconPencil size={16} />}
                data-testid="apps-listing-owner-edit"
              >
                Edit
              </Button>
            )}
            {/* Review affordance (thumbs/recommend) — hidden for the owner + signed-out
                viewers; the write proc is protected + flag-gated + self-review-blocked
                server-side. Feeds the recommend metric below SYNCHRONOUSLY. */}
            <ReviewListingButton appListingId={detail.id} ownerUserId={detail.creator?.id ?? null} />
            {/* Report affordance — dark behind the mod-only store surface; the
                proc is protected + rate-limited + reporter-bound server-side. */}
            <ReportListingButton appListingId={detail.id} />
          </Stack>
        </Box>
        )}
      </Group>

      {/* Recommend rollup + recent reviews are review AGGREGATES — omitted in
          preview (a shadow listing has none, and we must not query them). */}
      {!preview && (
        <>
          {/* Recommend rollup — Steam-style "N% recommend (M)" or "No reviews yet". */}
          <Group gap="md" wrap="wrap">
            <Group gap={6} wrap="nowrap">
              <IconThumbUp size={16} className={hasRecommend ? 'text-green-500' : 'text-gray-500'} />
              <Text size="sm" fw={500}>
                {recommendLabel}
              </Text>
            </Group>
            {hasRecommend && (
              <Text size="xs" c="dimmed">
                {detail.recommend.recommendedCount.toLocaleString()} recommend ·{' '}
                {detail.recommend.notRecommendedCount.toLocaleString()} don&apos;t
              </Text>
            )}
          </Group>

          {/* Recent reviews — thumbs/recommend list (mod-filtered, escaped plain text). */}
          <AppListingReviews appListingId={detail.id} />
        </>
      )}

      <ScreenshotGallery screenshots={detail.screenshots} name={detail.name} />

      {/* Description — shared CustomMarkdown (no dangerouslySetInnerHTML). */}
      {detail.description && (
        <>
          <Divider />
          <Stack gap="xs">
            <Title order={4}>About</Title>
            <div className="markdown-content">
              <CustomMarkdown>{detail.description}</CustomMarkdown>
            </div>
          </Stack>
        </>
      )}

      {/* Off-site external destination disclosure (mirrors the live detail). */}
      {detail.kindData.kind === 'offsite' &&
        detail.kindData.subKind === 'external-link' &&
        detail.kindData.externalUrl && (
          <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
            This app runs entirely off-platform — no Civitai install, account access, or
            permissions.
          </Alert>
        )}

      {/* CommentsV2 discussion — reuses the shared comment + moderation stack keyed
          on the listing's Thread (`entityType="appListing"`, integer surrogate).
          Additive + separate from the recommend-style reviews above. Only reached
          for an APPROVED listing (getListingDetail is approved-only) — omitted in
          preview (a shadow listing has no thread; loading it would 404/N+1). */}
      {!preview && (
        <AppListingComments serialId={detail.serialId} ownerUserId={detail.creator?.id ?? null} />
      )}
    </Stack>
  );
}
