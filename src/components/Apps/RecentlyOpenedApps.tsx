import { Anchor, Avatar, Card, Grid, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { getRecentRailTarget, type ResolvedRecentApp } from '~/components/Apps/recentAppsRail';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import {
  appInitial,
  listingPlaceholderGradient,
} from '~/shared/constants/app-listing-placeholder.constants';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';

/**
 * "Recently opened" marketplace sections. TWO views live here:
 *
 *  - `RecentlyOpenedAppsView` — the LEGACY `AvailableBlock`/`AppBlockCard`
 *    strip, consumed by `MarketplaceBody` (the documented one-line `/apps`
 *    rollback). Left byte-compatible on purpose so that rollback keeps
 *    compiling.
 *  - `RecentlyOpenedListingsView` — the LISTING-shaped rail rendered at the top
 *    of the unified `/apps` store (`AppListingsMarketplaceBody`). It renders
 *    straight from the localStorage entries (see `recentAppsRail.ts`) rather
 *    than resolving them against the loaded listing pages, for two reasons: a
 *    recently-opened app may simply not be on the loaded page (so resolution
 *    would silently drop it), and a resolve-after-fetch rail pops in AFTER the
 *    grid renders — exactly the layout shift the "renders nothing when empty"
 *    invariant is trying to avoid.
 *
 * Both share the invariant below.
 *
 * INVARIANT (tested, both views): with no entries the WHOLE section is hidden
 * (returns null) — a brand-new viewer sees nothing, not an empty "Recently
 * opened" header, and no space is reserved.
 */

/**
 * "Recently opened" marketplace section — a compact strip of the apps the
 * viewer most recently opened, sourced from localStorage (see
 * `recentlyOpenedAppsStore.ts`) and resolved against the public listing.
 *
 * Split into a PURE presentational `RecentlyOpenedAppsView` (props-only, no
 * localStorage / no tRPC) so it renders in isolation for component tests; the
 * `/apps` page owns the localStorage read + the resolve-against-listing wiring
 * and passes the resolved `blocks` down.
 *
 * INVARIANT (tested): when `blocks` is empty the WHOLE section is hidden
 * (returns null) — a brand-new viewer with no recents sees nothing, not an
 * empty "Recently opened" header.
 */
export interface RecentlyOpenedAppsViewProps {
  /** The resolved recent apps, newest-first. Empty → the section is hidden. */
  blocks: AvailableBlock[];
  subsByBlock: Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>;
  onOpen: (block: AvailableBlock) => void;
  /** M1 — record a route/title open from a recents card back into recents
   *  (re-opening from the strip moves the app to the front via the store). */
  onRecentOpen?: (block: AvailableBlock) => void;
  earningsByAppBlockId: Map<string, number>;
  canOpenPage: boolean;
}

export function RecentlyOpenedAppsView({
  blocks,
  subsByBlock,
  onOpen,
  onRecentOpen,
  earningsByAppBlockId,
  canOpenPage,
}: RecentlyOpenedAppsViewProps) {
  // Hide the entire section when there are no recents (new viewer).
  if (blocks.length === 0) return null;

  return (
    <Stack gap="xs" component="section" aria-label="Recently opened">
      <Title order={3}>Recently opened</Title>
      <Grid gutter="md">
        {blocks.map((block) => (
          <Grid.Col key={block.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
            <AppBlockCard
              block={block}
              alreadySubscribed={subsByBlock.has(block.id)}
              onOpen={onOpen}
              onRecentOpen={onRecentOpen}
              ownedEarningCents={earningsByAppBlockId.get(block.id)}
              canOpenPage={canOpenPage}
            />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}

export interface RecentlyOpenedListingsViewProps {
  /** Resolved recents, newest-first (see `selectRecentRailEntries`). Empty →
   *  the section is hidden entirely. */
  entries: ResolvedRecentApp[];
  /** Mirrors the `appBlocksPages` flag — decides whether an on-site page app
   *  re-opens at `/apps/run/<blockId>` or falls back to the unified detail. */
  canOpenPage: boolean;
  /**
   * Fired when an entry is followed, so the page can move it back to the front
   * of the recents list. Matters most for the OFF-SITE entries: following the
   * external link leaves the SPA, so nothing else would re-record the open.
   */
  onOpenRecent?: (entry: ResolvedRecentApp) => void;
}

/**
 * One compact recents tile: app icon + name, the whole tile being the link. Kept
 * deliberately smaller than `AppListingCard` (no cover, no CTA row, no recommend
 * rollup) — this is a "jump back in" rail above the store, not a second grid —
 * but it reuses the SAME per-app seeded icon placeholder + monogram
 * (`listingPlaceholderGradient` / `appInitial`) as the cards below, so one app
 * reads as one identity across both surfaces.
 */
function RecentTile({
  entry,
  canOpenPage,
  onOpenRecent,
}: {
  entry: ResolvedRecentApp;
  canOpenPage: boolean;
  onOpenRecent?: (entry: ResolvedRecentApp) => void;
}) {
  const target = getRecentRailTarget(entry, { canOpenPage });
  const label = entry.name ?? entry.slug;
  // External targets are https-guarded upstream (`safeExternalHref`) and get the
  // standard new-tab hardening; internal ones route through next/link.
  const anchorProps = target.external
    ? { href: target.href, target: '_blank', rel: 'noopener noreferrer' }
    : { component: Link, href: target.href };

  return (
    <Anchor
      {...anchorProps}
      underline="never"
      c="inherit"
      data-testid="apps-recent-rail-item"
      onClick={() => onOpenRecent?.(entry)}
    >
      <Card withBorder padding="xs" radius="md">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Avatar
            src={entry.iconUrl ?? undefined}
            alt=""
            radius="md"
            size={32}
            style={{ flexShrink: 0 }}
            data-listing-icon-placeholder={entry.iconUrl == null ? '' : undefined}
            styles={{
              placeholder: {
                background: listingPlaceholderGradient({
                  slug: entry.slug,
                  category: null,
                  surface: 'icon',
                }),
                color: 'var(--mantine-color-white)',
                fontWeight: 700,
              },
            }}
          >
            {appInitial(label, entry.slug)}
          </Avatar>
          <TruncatedText size="sm" fw={500} lineClamp={1} tooltipLabel={label} style={{ minWidth: 0 }}>
            {label}
          </TruncatedText>
          {target.external && (
            <IconExternalLink size={14} style={{ flexShrink: 0 }} className="opacity-60" />
          )}
        </Group>
      </Card>
    </Anchor>
  );
}

/**
 * The `/apps` "Recently opened" rail (listing-shaped). Renders NOTHING — not
 * even a heading or a spacer — when the viewer has no resolvable recents, so a
 * first-time visitor's page is byte-identical to today's.
 */
export function RecentlyOpenedListingsView({
  entries,
  canOpenPage,
  onOpenRecent,
}: RecentlyOpenedListingsViewProps) {
  if (entries.length === 0) return null;

  return (
    <Stack gap="xs" component="section" aria-label="Recently opened" data-testid="apps-recent-rail">
      <Group justify="space-between" align="center">
        <Title order={4}>Recently opened</Title>
        <Text size="xs" c="dimmed">
          Jump back in
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="xs">
        {entries.map((entry) => (
          <RecentTile
            key={entry.id}
            entry={entry}
            canOpenPage={canOpenPage}
            onOpenRecent={onOpenRecent}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
}
