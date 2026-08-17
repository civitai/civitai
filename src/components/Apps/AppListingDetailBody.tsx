import {
  Accordion,
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
  Menu,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconApps,
  IconArrowLeft,
  IconDotsVertical,
  IconDownload,
  IconFlag,
  IconInfoCircle,
  IconPencil,
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
import { ACTION_GLYPH_ICONS, detailActionGlyph } from '~/components/Apps/appListingActionGlyph';
import { getRecommendLabel } from '~/components/Apps/appListingCardView';
import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import {
  canOwnerEditListing,
  type DetailActionMode,
  getDetailPrimaryAction,
  getOwnerEditHref,
} from '~/components/Apps/appListingDetailView';
import { toRecentAppFromListing } from '~/components/Apps/recentAppsRail';
import { recordRecentlyOpenedApp } from '~/components/Apps/recentlyOpenedAppsStore';
import { RelatedListings } from '~/components/Apps/RelatedListings';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { ListingCollaboratorByline } from '~/components/Apps/ListingCollaboratorByline';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AppListingComments } from '~/components/Apps/AppListingComments';
import { ReportListingModal, useCanReportListing } from '~/components/Apps/ReportListingButton';
import { ReviewListingModal, useCanReviewListing } from '~/components/Apps/ReviewListingButton';
import { AppListingReviews } from '~/components/Apps/AppListingReviews';
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORY_ICON,
} from '~/components/Apps/marketplaceCategoryIcons';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { StatHoverCard } from '~/components/Stats/StatHoverCard';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import { formatDate } from '~/utils/date-helpers';
import detailClasses from '~/components/Model/ModelVersions/ModelVersionDetails.module.scss';
import type {
  ListingDetail,
  ListingGalleryScreenshot,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — the unified listing DETAIL body (over BOTH kinds).
 *
 * Renders one `ListingDetail` (from `appListings.getAppDetail`) in the MODEL DETAIL
 * PAGE's layout, deliberately: a full-bleed hero, then a header block (icon + name +
 * tagline + collaborator byline + interactive stat chips + a `⋮` overflow menu + an
 * `Updated: <date> │ <category>` meta line), then a two-column `ContainerGrid2` — main
 * content left (screenshots, `About` under a `ContentClamp`), a stack of `Card
 * withBorder` rails right (the primary action, the `SmartCreatorCard`, a "Details"
 * accordion) — then the full-width discovery rail, reviews and discussion.
 *
 * 🔴 THE LAYOUT IS A PORT, NOT AN INVENTION. The grid spans (`{base:12, sm:7, md:8}`
 * / `{base:12, sm:5, md:4}` with `order={{sm:…}}`), the `Card.Section withBorder
 * inheritPadding` rail headers, the `.detailsPanel`/`.detailRow`/`.detailLabel`
 * classes (imported from `ModelVersionDetails.module.scss` rather than re-declared),
 * the `IconBadge` + `StatHoverCard` stat chips, the `Updated:` + `Divider` + category
 * `Badge` meta line and the `Title order={2}` discussion heading all come from
 * `src/pages/models/[id]/[[...slug]].tsx` + `ModelVersionDetails.tsx`. Keep them in
 * step with those files; where this page differs it is because a listing has no
 * equivalent (there are NO TAGS on a listing — do not invent a tag row).
 *
 * The page container widened with it: `/apps/store-preview/[slug]` moved from
 * `APPS_READABLE_PAGE_WIDTH` (1100, a single readable column) to
 * `APPS_TWO_COLUMN_DETAIL_PAGE_WIDTH` (1320 = Mantine `xl`, the model page's own
 * container). See `appsPageWidths.ts` for why that is a fourth width class.
 *
 * DARK / parallel-run: rendered by the mod-only `/apps/store-preview/<slug>` surface
 * AND, in read-only `preview` mode (see props), by the moderator listing-media review
 * as a store preview of an unapproved shadow listing.
 *
 * 🔴 This body is the DESTINATION of the retired `/apps/[appBlockId]` route (#3493
 * redirects it here for any app with an approved listing), so nothing in this file may
 * link back to `/apps/<appBlockId>` — that is a redirect loop onto the page the viewer
 * is already reading. See `getDetailPrimaryAction`'s model-slot branch. Pinned as a
 * source gate in `__tests__/appListingDetailView.test.ts`. `AppDetailsModal` + the
 * default `/apps` grid are byte-unchanged by this change.
 *
 * ⚠️ KNOWN GAP (tracked by #3493, deliberately NOT closed here): this body has no
 * INSTALL surface, so a model-slot app — one that installs into a slot rather than
 * opening a page — has nowhere on the store detail to install from. Vacuous today
 * (every approved on-site listing declares a page).
 *
 * 🔴 THERE IS NO IN-PAGE LIVE PREVIEW HERE, AND ONE MUST NOT BE RE-ADDED AS A BARE
 * `<iframe src={liveUrl}>`. This body used to mount exactly that (inherited verbatim
 * from the retired `/apps/[appBlockId]` page, whose own docstring already named the
 * defect). A block at `<slug>.civit.ai` does not boot from its URL alone — it waits
 * for a host to post `BLOCK_INIT` over the block bridge. Nothing posted it to that
 * frame, so the frame only ever painted the block's pre-init LIGHT-theme shell
 * (`#FEFEFE`) inside a dark listing page. Neither escape hatch fires from inside a
 * frame either: the build-recipe edge redirect keys on `Sec-Fetch-Dest: document` (an
 * iframe sends `iframe`) and the SDK `<BlockGate>` landing keys on
 * `window.self === window.top` (false in a frame). A future preview here needs a real
 * host bridge — the moderator review surface (`ReviewBlockPreviewHost`) is the working
 * reference — not another raw frame. To run an on-site app from this page the viewer
 * takes the kind-aware primary action (`getDetailPrimaryAction`): today that is `Open`
 * → `/apps/run/<slug>` for every viewer who can reach this page — see the flag note on
 * `appListingDetailView`. The hero banner is a SECOND affordance for that same action
 * and nothing more: a plain `<a href>` to the identical route (see `HeroCover`). It is
 * not, and must not become, an embedded runtime.
 *
 * Structurally pinned in the node `unit` project
 * (`__tests__/appListingDetailView.test.ts`, "no raw `<iframe>` may return"), because
 * CI does not run the browser `component` suite.
 *
 * XSS / encoding discipline (mirrors P2b): external hrefs are https-guarded in the
 * pure view-model (`safeExternalHref`) + rendered with rel="noopener noreferrer"
 * target="_blank"; the markdown description goes through the shared `CustomMarkdown`
 * (react-markdown, no `dangerouslySetInnerHTML`). 🔴 `ContentClamp` wraps that markdown
 * — it does NOT replace it. Do not swap in `RenderHtml` to get a nicer clamp: the
 * markdown path is the XSS posture, not a formatting preference.
 *
 * Reuse tradeoff still live (flagged in the PR, consistent with P2b):
 *   - Cover: `AspectRatioImageCard` (cosmetic frames / per-image blur) needs a full
 *     `Image` object; the allowlist DTO projects only a `coverUrl` string, so we render
 *     a plain cover with the category-glyph placeholder fallback (same as the card).
 *     Feeding it would be a P2a schema addition.
 *
 * (The creator tradeoff that used to sit here — "`UserAvatarSimple` wants a rich
 * `ProfileImage` + cosmetics object, so we render a lightweight chip" — is GONE, and
 * so is the chip. `CreatorCardSimple` needs only `{ id }` and fetches the rest itself
 * through the PUBLIC `user.getCreator` procedure, which this anon-reachable page may
 * call; the DTO has always carried `creator.id`.)
 */

function categoryIcon(category: string): Icon {
  return isMarketplaceCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

/**
 * Hero cover — the listing cover (`coverUrl`, already a CDN URL). Falls back to a
 * category-glyph placeholder over the listing's DETERMINISTIC PER-APP seeded
 * gradient (shared with the server-generated cover SVG — see
 * `~/shared/constants/app-listing-placeholder.constants`) when absent OR the
 * image 404s (a coverUrl derived from a first-screenshot fallback can dangle) —
 * never a broken `<img>`. The art itself is decorative (aria-hidden placeholder).
 *
 * CLICK-TO-LAUNCH (`launchHref`): when the caller supplies a launch target the
 * WHOLE banner becomes a real anchor to it — the same destination as the primary
 * `Open` CTA. It wraps BOTH branches: a listing with no cover art gets the
 * affordance over its seeded-gradient placeholder exactly like one with a cover,
 * because "has no art yet" is not a reason to lose the way in. The caller
 * decides WHEN there is a target (see `heroLaunchHref` in the body) — this
 * component only decides how it renders.
 *
 * 🔴 It is an `<a href>`, never a `<div onClick>`. The banner has to be
 * tab-reachable, Enter-activatable and middle-/modifier-clickable like any other
 * link, and it has to expose an accessible NAME — which neither branch can
 * supply on its own: the cover `alt` describes the PICTURE ("<app> cover image")
 * and the placeholder is `aria-hidden` with no text at all. Hence the explicit
 * `aria-label`, worded to match the CTA it mirrors. Nothing inside the banner is
 * interactive, so this nests no controls.
 *
 * 🔴 NO recents side effect here, DELIBERATELY — verified against the CTA rather
 * than assumed. `/apps/run/<slug>` records the open itself, in a mount effect
 * (`recordRecentlyOpenedApp` in the run page), which is exactly why the `open`
 * branch of `PrimaryAction` carries no `onClick` either; only the off-site
 * `visit` branch records, because following that link leaves the SPA and nothing
 * downstream could. An `onClick` here would therefore write the entry TWICE per
 * launch — once from the listing DTO, once from the run page — and silently
 * diverge the banner from the button it is meant to mirror. Pinned, against a
 * positive control, in `AppListingDetailBody.browser.test.tsx`.
 */
function HeroCover({
  coverUrl,
  category,
  name,
  slug,
  launchHref = null,
}: {
  coverUrl: string | null;
  category: string | null;
  name: string;
  slug: string;
  /** Internal launch target; `null` → the banner stays decorative + inert. */
  launchHref?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const PlaceholderIcon = category ? categoryIcon(category) : IconApps;
  const art =
    coverUrl && !broken ? (
      <Image
        src={coverUrl}
        alt={`${name} cover image`}
        h={260}
        fit="cover"
        radius="md"
        onError={() => setBroken(true)}
      />
    ) : (
      // Per-app SEEDED gradient — same seed/stops as the generated cover SVG and
      // the store card, so one listing reads as one identity across every surface.
      <Box
        aria-hidden
        h={260}
        className="flex items-center justify-center"
        data-listing-cover-placeholder=""
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          background: listingPlaceholderGradient({ slug, category, surface: 'cover' }),
        }}
      >
        <PlaceholderIcon size={72} className="opacity-60" />
      </Box>
    );

  if (!launchHref) return art;

  return (
    <Anchor
      component={Link}
      href={launchHref}
      aria-label={`Open ${name}`}
      data-testid="apps-listing-hero-launch"
      underline="never"
      // 🔴 `c="inherit"` is load-bearing, not cosmetic. Mantine's Anchor root sets
      // `color: var(--mantine-color-anchor)` (blue-4 `#4DABF7` in dark scheme), and
      // Tabler icons stroke with `currentColor` — so without this the no-cover
      // placeholder's 72px category glyph turns link-blue instead of staying the
      // page's grey `--mantine-color-text`. The cover-IMAGE branch is unaffected
      // (an `<img>` ignores `color`), which is exactly why this is easy to miss:
      // it only shows on listings with no cover. `CreatorChip` in AppListingCard
      // carries `c="dimmed"` for the same reason.
      // Not covered by the component suite — it loads no CSS (vitest.config.mts
      // registers only the process shim and component-setup), so every visual
      // claim here is reasoning, not measurement.
      c="inherit"
      // Minimal, card-idiom affordance: pointer + a small hover dim + the
      // site's `focus-visible:ring` pattern, so the banner reads as pressable
      // without becoming a redesign. `focus:outline-none` is paired with a ring
      // (never bare), so keyboard focus stays VISIBLE.
      className="block transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-5"
      // 🔴 Mantine's `md` radius (8px), not Tailwind's `rounded-md` (6px) — the
      // inner cover `<Image radius="md">` and the placeholder Box both use the
      // Mantine token, and mixing the two `md`s leaves a visible corner seam.
      style={{ display: 'block', borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}
    >
      {art}
    </Anchor>
  );
}

/**
 * Header STAT CHIPS — the model page's `IconBadge` + `StatHoverCard` row, over the two
 * public aggregates a listing has: recommendations and installs.
 *
 * 🔴 Each chip carries `data-listing-stat="<key>"` AND an `aria-label`. The attribute
 * is what the a11y test asserts on: a chip's visible text is a bare number, which any
 * other feature on the page could also spell, so a text-shaped assertion would not be
 * about these elements at all. The label is the accessible NAME the number alone
 * cannot supply.
 *
 * 🔴 OMITTED ENTIRELY IN `preview` — see the posture note on the body. Both numbers are
 * review/usage aggregates that a shadow listing structurally does not have.
 */
function StatChips({ detail }: { detail: ListingDetail }) {
  // The card's percentage label ("87% recommend (340)") is retained HERE, in the hover
  // card, rather than in the header text — the header now reads the Steam-style word
  // label in the Details rail, matching the model page. `getRecommendLabel` itself is
  // UNCHANGED and still backs the store grid cards; adding a second return shape for
  // this one surface would have changed every card.
  const recommendDetail = getRecommendLabel(detail.recommend, detail.reviewCount);
  return (
    <Group gap={4} wrap="wrap">
      <StatHoverCard
        label="Recommendations"
        value={detail.recommend.recommendedCount}
        message={detail.recommend.recommendPct == null ? recommendDetail : undefined}
      >
        <div>
          <IconBadge
            radius="sm"
            size="lg"
            icon={<IconThumbUp size={18} />}
            data-listing-stat="recommend"
            aria-label={`${detail.recommend.recommendedCount.toLocaleString()} recommendations`}
          >
            <Text size="sm">{detail.recommend.recommendedCount.toLocaleString()}</Text>
          </IconBadge>
        </div>
      </StatHoverCard>
      <StatHoverCard label="Installs" value={detail.installCount}>
        <div>
          <IconBadge
            radius="sm"
            size="lg"
            icon={<IconDownload size={18} />}
            data-listing-stat="installs"
            aria-label={`${detail.installCount.toLocaleString()} installs`}
          >
            <Text size="sm">{detail.installCount.toLocaleString()}</Text>
          </IconBadge>
        </div>
      </StatHoverCard>
    </Group>
  );
}

/**
 * "by {creator}" chip — the public creator projection ({id,username,image}).
 *
 * 🔴 RETAINED ONLY FOR THE `preview` POSTURE. The live page shows the creator in the
 * right rail's `SmartCreatorCard`; the moderator review preview omits that rail (it is
 * a live tRPC surface over a user who is not the subject of the review), so the shadow
 * preview would otherwise lose the submitter's identity entirely. One chip, one place.
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
    <Stack gap="xs">
      <Title order={4}>Screenshots</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {shots.map((shot, i) => (
          <ScreenshotTile key={`${shot.url}-${i}`} shot={shot} name={name} index={i} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/** Kind-aware primary action button + (for info/connect stubs) an inline note. */
function PrimaryAction({ detail, canOpenPage }: { detail: ListingDetail; canOpenPage: boolean }) {
  const action = getDetailPrimaryAction(detail, { canOpenPage });

  // 🔴 Resolve the glyph INSIDE each branch, from the mode that branch has
  // already established — never once up front from `action.mode`. `href` is
  // optional on `DetailPrimaryAction`, so an `open`/`visit` action without one
  // falls through to the informational return at the bottom; a single hoisted
  // lookup would paint a launch icon there. Not reachable from today's
  // `getDetailPrimaryAction`, which is exactly why it is worth making
  // structurally impossible rather than relying on that staying true.
  //
  // `open` (in-site nav to /apps/run/<slug>, no target) and `visit` (external
  // new tab) used to share `IconExternalLink`, which left the CTA carrying no
  // on-site/off-site signal at all — the signal #3391 removed the kind badges on
  // the grounds that the CTA already carried. Mapping pinned in
  // `__tests__/appListingActionGlyph.test.ts`.
  const glyphFor = (mode: DetailActionMode) => ACTION_GLYPH_ICONS[detailActionGlyph(mode)];

  if (action.mode === 'open' && action.href) {
    const GlyphIcon = glyphFor('open');
    return (
      <Button component={Link} href={action.href} leftSection={<GlyphIcon size={16} />} fullWidth>
        {action.label}
      </Button>
    );
  }

  if (action.mode === 'visit' && action.href) {
    const GlyphIcon = glyphFor('visit');
    return (
      <Stack gap={4}>
        <Button
          component="a"
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          leftSection={<GlyphIcon size={16} />}
          data-testid="apps-listing-open-live"
          fullWidth
          // Reached by an OFF-SITE listing ("Visit") and by an on-site PAGE app
          // whose viewer can't open the in-host route ("Open live" — the
          // raw-origin escape hatch, see `getDetailPrimaryAction`). Either way,
          // following this link IS the moment the app is opened, and it leaves
          // the SPA — so it is the only chance to record the open. A detail-page
          // VIEW never records.
          onClick={() => recordRecentlyOpenedApp(toRecentAppFromListing(detail))}
        >
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

  if (action.mode === 'connect') {
    // Honest stub for a connect listing with NO destination at all: inert button
    // + a note, so the affordance is never a dead 404 link.
    //
    // 🔴 This is NOT the ordinary connect case any more. A connect listing that
    // carries an https `externalUrl` — which is every one in production — takes
    // the `visit` branch above and renders a real `Visit ↗`. The mode used to be
    // returned unconditionally for the sub-kind, which made this inert button
    // the ONLY thing a viewer ever saw for an app with a linked OAuth client.
    // See `getDetailPrimaryAction`.
    const GlyphIcon = glyphFor('connect');
    return (
      <Stack gap={4}>
        <Button variant="default" leftSection={<GlyphIcon size={16} />} disabled fullWidth>
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

  // Informational (`info`) — a note plus, if the action ever carries one, an
  // internal "learn more" link. `getDetailPrimaryAction` produces NO href for
  // `info` today (the only such target was the retired `/apps/[appBlockId]`),
  // so the text-only arm is the live one; the link arm is kept as the type's
  // optional-href contract, NOT as a place to reinstate a circular self-link.
  //
  // 🔴 Hard-coded to the `info` glyph, NOT `action.mode`. This is the fallthrough
  // — an `open`/`visit` action that lost its href lands here, and it must wear
  // the informational icon it is actually rendering, not the launch icon its
  // mode still claims.
  const GlyphIcon = glyphFor('info');
  return (
    <Stack gap={4}>
      {action.href ? (
        <Button
          component={Link}
          href={action.href}
          variant="default"
          leftSection={<GlyphIcon size={16} />}
          fullWidth
        >
          {action.label}
        </Button>
      ) : (
        <Group gap={6} c="dimmed">
          <GlyphIcon size={16} />
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

/**
 * The "Details" accordion in the right rail — the model page's version-details panel,
 * over the listing's scalars. Rows come from the PURE `buildListingDetailRows`, so the
 * order / omission / preview rules are pinned in the blocking node project rather than
 * here (see `appListingDetailRows.ts`).
 *
 * The `.detailsPanel` / `.detailRow` / `.detailLabel` classes are IMPORTED from
 * `ModelVersionDetails.module.scss`, not copied: two copies of a border colour is
 * exactly how two surfaces stop matching.
 */
function DetailsPanel({ detail, preview }: { detail: ListingDetail; preview: boolean }) {
  const rows = buildListingDetailRows(detail, { preview, formatDate: (iso) => formatDate(iso) });
  return (
    <Accordion
      variant="contained"
      defaultValue="listing-details"
      data-testid="apps-listing-details-accordion"
      styles={{ content: { padding: 0 } }}
    >
      <Accordion.Item value="listing-details">
        <Accordion.Control>Details</Accordion.Control>
        <Accordion.Panel p={0}>
          <Stack gap={0} className={detailClasses.detailsPanel}>
            {rows.map((row) => (
              <div
                key={row.key}
                className={detailClasses.detailRow}
                data-listing-detail-row={row.key}
              >
                <Text className={detailClasses.detailLabel}>{row.label}</Text>
                <Text size="sm" c={row.color} tt={row.key === 'reviews' ? 'capitalize' : undefined}>
                  {row.value}
                </Text>
              </div>
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export interface AppListingDetailBodyProps {
  detail: ListingDetail;
  /** Whether the viewer can launch an in-host page app (the `appBlocksPages` flag). */
  canOpenPage?: boolean;
  /**
   * READ-ONLY preview posture. When set, render ONLY the presentational parts —
   * hero cover, icon, name, tagline, creator chip, content-rating in the Details
   * rail, screenshot gallery, description markdown — and OMIT every LIVE/interactive
   * or AGGREGATE surface. The full omission ledger, each item a deliberate decision:
   *
   *   - the comments thread + the recommend reviews list (a shadow listing has no
   *     Thread and no review rows; querying them would 404 / N+1),
   *   - the header STAT CHIPS (recommendations + installs are usage aggregates a
   *     shadow listing structurally does not have — zeros there would read as facts
   *     about the app rather than about the posture),
   *   - the `⋮` overflow MENU and everything in it (owner edit, review, report) —
   *     every item is a live action on an UN-APPROVED listing,
   *   - the right-rail ACTION CARD (primary action) and the clickable hero, for the
   *     same reason,
   *   - the `SmartCreatorCard` (a live tRPC surface; the read-only `CreatorChip`
   *     stands in so the submitter is still identified),
   *   - the header META LINE (`Updated:` + category), whose date is the publish
   *     request's submission time rather than a listing's `updated_at`,
   *   - the Details rail's REVIEWS row (same reason as the chips),
   *   - the related-listings rail and the back-to-store link.
   *
   * The Details ACCORDION itself is KEPT: kind / category / rating / installs /
   * updated are exactly the scalars a moderator is reviewing, and the reviews row is
   * dropped inside the pure row builder.
   *
   * Used by the moderator listing-media review to render an unapproved SHADOW listing
   * as a store preview. Every omission above has its own test, each paired with a
   * positive control from the non-preview arm.
   */
  preview?: boolean;
}

export function AppListingDetailBody({
  detail,
  canOpenPage = false,
  preview = false,
}: AppListingDetailBodyProps) {
  const currentUser = useCurrentUser();

  // Owner "Edit" deep-link (Item 2) — owner + editable status (approved-only read
  // path carries no status → editable); the href builder returns null when there
  // is no editable target (on-site listing with no backing appBlockId).
  const isOwner = !!currentUser?.id && currentUser.id === detail.creator?.id;
  const editHref = getOwnerEditHref(detail.kindData, detail.id);
  const showEdit = canOwnerEditListing({ isOwner }) && !!editHref;

  // 🔴 The review / report modals are owned HERE, not by their trigger. A Mantine
  // `Menu.Dropdown` is unmounted when the menu closes, so a modal rendered as a
  // sibling of its `Menu.Item` would be destroyed by the click that opens it. The
  // gates are the SAME predicates the standalone buttons use (`useCanReviewListing`
  // / `useCanReportListing`), imported rather than re-derived, so the menu cannot
  // disagree with them about who may act.
  const canReview = useCanReviewListing({ ownerUserId: detail.creator?.id ?? null });
  const canReport = useCanReportListing();
  const [reviewOpened, reviewModal] = useDisclosure(false);
  const [reportOpened, reportModal] = useDisclosure(false);

  // Hero click-to-launch — the banner is an affordance for the SAME destination
  // as the primary CTA, derived FROM that CTA (`getDetailPrimaryAction`) rather
  // than by re-deriving the kind matrix, so the two cannot drift apart.
  //
  // 🔴 ON-SITE `open` ONLY. Three deliberate exclusions, each a decision:
  //   - `visit` — both the off-site listing AND the on-site raw-origin "Open
  //     live" escape hatch. Silently shipping a viewer off-platform from what
  //     reads as decorative art is a surprise; an off-site destination deserves
  //     the labelled, new-tab "Visit ↗" button, so the banner stays inert. The
  //     `!external` guard says the same thing structurally, in case a future
  //     `open` ever carries `external: true`.
  //   - no href (`info` model-slot / `connect` stub) — nothing to launch, and
  //     `DetailPrimaryAction.href` is optional, so this is a real branch.
  //   - `preview` — the moderator listing-media review renders this body
  //     READ-ONLY and omits the entire action column. A clickable banner there
  //     would put a live launch back onto an UNAPPROVED shadow listing, which is
  //     precisely what that posture exists to prevent.
  const primaryAction = getDetailPrimaryAction(detail, { canOpenPage });
  const heroLaunchHref =
    !preview && primaryAction.mode === 'open' && !primaryAction.external && primaryAction.href
      ? primaryAction.href
      : null;

  const showMenu = !preview && (showEdit || canReview || canReport);

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
        launchHref={heroLaunchHref}
      />

      {/* HEADER — the model page's title block: identity + stats on the left, the
          overflow menu on the right, the meta line underneath. */}
      <Stack gap={4}>
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
              {/* 🔴 The PUBLIC collaborator byline. `detail.collaborators` has ALREADY been
                  filtered server-side to ACCEPTED **and** `displayed` seats and projected
                  to `{id, username, image}` — this renders it verbatim and applies no
                  policy of its own (see ListingCollaboratorByline's header). */}
              <ListingCollaboratorByline collaborators={detail.collaborators} />
              {/* The creator identity lives in the right rail's CreatorCard on the live
                  page; in preview that rail is omitted, so the lightweight chip stands
                  in rather than leaving a moderator with no submitter at all. */}
              {preview && <CreatorChip creator={detail.creator} />}
              {!preview && <StatChips detail={detail} />}
            </Stack>
          </Group>

          {/* Overflow menu — the secondary actions, collapsed. Replaces the stacked
              full-width button column; the PRIMARY action stays a real button in the
              right-rail action card, never buried in here. */}
          {showMenu && (
            <Box style={{ flexShrink: 0 }}>
              <Menu position="bottom-end" transitionProps={{ transition: 'pop-top-right' }} withinPortal>
                <Menu.Target>
                  <LegacyActionIcon
                    variant="light"
                    aria-label="App options"
                    data-testid="apps-listing-actions-menu"
                  >
                    <IconDotsVertical size={20} />
                  </LegacyActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {/* Owner-only "Edit" deep-link, gated by owner + editable status
                      (mod-removed listings hide it). Routes by kind (manifest editor
                      for on-site, submit editor for off-site). */}
                  {showEdit && editHref && (
                    <Menu.Item
                      component={Link}
                      href={editHref}
                      leftSection={<IconPencil size={14} stroke={1.5} />}
                      data-testid="apps-listing-owner-edit"
                    >
                      Edit
                    </Menu.Item>
                  )}
                  {/* Review affordance (thumbs/recommend) — hidden for the owner + signed-out
                      viewers by `useCanReviewListing`; the write proc is protected +
                      flag-gated + self-review-blocked server-side. */}
                  {canReview && (
                    <Menu.Item
                      leftSection={<IconThumbUp size={14} stroke={1.5} />}
                      onClick={reviewModal.open}
                      data-testid="apps-listing-review-action"
                    >
                      Leave a review
                    </Menu.Item>
                  )}
                  {/* Report affordance — dark behind the mod-only store surface; the
                      proc is protected + rate-limited + reporter-bound server-side. */}
                  {canReport && (
                    <Menu.Item
                      color="red"
                      leftSection={<IconFlag size={14} stroke={1.5} />}
                      onClick={reportModal.open}
                      data-testid="apps-listing-report-action"
                    >
                      Report
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            </Box>
          )}
        </Group>

        {/* META LINE — `Updated: <date>` │ category, exactly as the model page renders
            it. 🔴 There is NO TAG ROW: a listing has no tags, and inventing one from
            the category would duplicate the badge beside it. */}
        {!preview && (
          <Group gap={4} data-testid="apps-listing-meta">
            <Text size="xs" c="dimmed">
              Updated: {formatDate(detail.updatedAt)}
            </Text>
            {detail.category && (
              <>
                <Divider orientation="vertical" />
                {/* Plain badge, NOT a link. The model page links its category to
                    `/tag/<name>`; the store has no category-filtered ROUTE — `/apps`
                    holds its category filter in client state, not in the URL — so a
                    link here would either 404 or land on an unfiltered grid. */}
                <Badge size="sm" color="blue" data-testid="apps-listing-category">
                  {detail.category}
                </Badge>
              </>
            )}
          </Group>
        )}
      </Stack>

      {/* TWO COLUMNS — spans, source order and `order={{sm}}` all copied from
          `ModelVersionDetails`, including the part that looks backwards: the RAIL is
          FIRST in the DOM and carries `order={{sm:2}}`, which moves it to the right on
          a wide container. Below the `sm` CONTAINER breakpoint the order props stop
          applying and the base span of 12 stacks the two, so the rail lands ABOVE the
          content on a phone — the primary action, creator and details before the
          screenshots and prose. That is the model page's own mobile behaviour (its
          Download card stacks first the same way), and it is deliberate here for the
          same reason: on a small screen the way IN should not be below a gallery.
          🔴 Do not "fix" the source order to put the main column first — that silently
          changes the mobile stack. Pinned in `AppListingDetailBody.browser.test.tsx`. */}
      <ContainerGrid2 gutter={{ base: 'xl', sm: 'sm', md: 'xl' }}>
        <ContainerGrid2.Col
          span={{ base: 12, sm: 5, md: 4 }}
          order={{ sm: 2 }}
          data-testid="apps-listing-rail-col"
        >
          <Stack gap="md">
            {/* Action card — the primary CTA, in the rail, as a real button. */}
            {!preview && (
              <Card withBorder data-testid="apps-listing-action-card">
                <Card.Section withBorder inheritPadding py="xs" px="sm">
                  <Text size="sm" fw={600}>
                    Get this app
                  </Text>
                </Card.Section>
                <Card.Section inheritPadding py="sm" px="sm">
                  <PrimaryAction detail={detail} canOpenPage={canOpenPage} />
                </Card.Section>
              </Card>
            )}

            {/* Creator card. `{ id }` is all it needs — `CreatorCardSimple` fetches the
                rest through the PUBLIC `user.getCreator` procedure (verified public:
                `user.router.ts`), which matters because this page is anon-reachable by
                design. Tips are OFF: buzz tipping is keyed on an entity type the buzz
                service knows, and `AppListing` is not one of them. */}
            {!preview && detail.creator && (
              <Box data-testid="apps-listing-creator-card">
                <SmartCreatorCard user={{ id: detail.creator.id }} tipsEnabled={false} />
              </Box>
            )}

            <DetailsPanel detail={detail} preview={preview} />
          </Stack>
        </ContainerGrid2.Col>

        <ContainerGrid2.Col
          span={{ base: 12, sm: 7, md: 8 }}
          order={{ sm: 1 }}
          data-testid="apps-listing-main-col"
        >
          <Stack gap="lg">
            <ScreenshotGallery screenshots={detail.screenshots} name={detail.name} />

            {/* Description — shared CustomMarkdown (no dangerouslySetInnerHTML), under
                the model page's `ContentClamp maxHeight={460}`. */}
            {detail.description && (
              <Stack gap="xs">
                <Title order={4}>About</Title>
                <ContentClamp maxHeight={460}>
                  <div className="markdown-content">
                    <CustomMarkdown>{detail.description}</CustomMarkdown>
                  </div>
                </ContentClamp>
              </Stack>
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
          </Stack>
        </ContainerGrid2.Col>
      </ContainerGrid2>

      {/* DISCOVERY — "More in <category>" + a persistent "Browse all apps" link.
          Placed AFTER the two-column body but BEFORE the reviews/comments: those
          threads are unbounded, so a rail below them would be buried behind an
          arbitrary amount of scrolling for the viewers most likely to want it (the
          ones who read the listing and didn't convert). Omitted in read-only preview —
          it is a live, tRPC-backed surface. */}
      {!preview && (
        <>
          <Divider />
          <RelatedListings listingId={detail.id} category={detail.category} />
        </>
      )}

      {/* Recent reviews — thumbs/recommend list (mod-filtered, escaped plain text).
          Full-width below the grid, with the model page's `Title order={2}` section
          heading. Omitted in preview: a shadow listing has no review rows and we must
          not query them. */}
      {!preview && (
        <Stack gap="md">
          <Divider />
          <Title order={2}>Reviews</Title>
          <AppListingReviews appListingId={detail.id} />
        </Stack>
      )}

      {/* CommentsV2 discussion — reuses the shared comment + moderation stack keyed
          on the listing's Thread (`entityType="appListing"`, integer surrogate).
          Additive + separate from the recommend-style reviews above. Only reached
          for an APPROVED listing (getListingDetail is approved-only) — omitted in
          preview (a shadow listing has no thread; loading it would 404/N+1). */}
      {!preview && (
        <AppListingComments serialId={detail.serialId} ownerUserId={detail.creator?.id ?? null} />
      )}

      {/* The two action modals, mounted OUTSIDE the menu — see the note where their
          state is declared. Each is gated by the same predicate as its menu item, so
          an ineligible viewer mounts neither the trigger nor the form. */}
      {!preview && canReview && (
        <ReviewListingModal
          appListingId={detail.id}
          opened={reviewOpened}
          onClose={reviewModal.close}
        />
      )}
      {!preview && canReport && (
        <ReportListingModal
          appListingId={detail.id}
          opened={reportOpened}
          onClose={reportModal.close}
        />
      )}
    </Stack>
  );
}
