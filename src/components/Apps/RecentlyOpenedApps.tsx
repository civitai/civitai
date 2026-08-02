import {
  ActionIcon,
  Anchor,
  Avatar,
  Card,
  Grid,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconExternalLink, IconEye, IconPlayerPlay } from '@tabler/icons-react';
import Link from 'next/link';
import clsx from 'clsx';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import {
  getRecentRailAction,
  getRecentRailTarget,
  type ResolvedRecentApp,
} from '~/components/Apps/recentAppsRail';
import classes from './RecentlyOpenedApps.module.scss';
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

/** Icon per action — the SAME vocabulary the store card's CTA row uses. */
const RECENT_ACTION_ICONS = {
  open: IconPlayerPlay,
  visit: IconExternalLink,
  view: IconEye,
} as const;

/**
 * One compact recents tile: app icon + name + an icon CTA. Kept deliberately
 * smaller than `AppListingCard` (no cover, no CTA row, no recommend rollup) —
 * this is a "jump back in" rail above the store, not a second grid — but it
 * reuses the SAME per-app seeded icon placeholder + monogram
 * (`listingPlaceholderGradient` / `appInitial`) as the cards below, so one app
 * reads as one identity across both surfaces.
 *
 * ── 🔴 STRUCTURE: WHY THIS IS NOT ONE BIG ANCHOR ────────────────────────────
 * It used to be `<Anchor><Card>…</Card></Anchor>`. Adding an icon button inside
 * that would nest a `<button>` (or a second `<a>`) inside an `<a>` — INVALID
 * HTML: the parser reparents the inner interactive element out of the anchor, so
 * the DOM you get is not the DOM you wrote, keyboard focus order becomes
 * undefined, and screen readers announce one control where there are two.
 *
 * The fix is the standard LINK-OVERLAY idiom, and it inverts the nesting:
 *   - the `Card` is the positioning context (`.tile` → `position: relative`);
 *   - the tile link wraps the VISIBLE APP NAME — so it has a real accessible
 *     name from its own text rather than a bolted-on `aria-label` — and its
 *     `::after` stretches over the whole card, keeping "click anywhere on the
 *     tile" intact;
 *   - the `ActionIcon` is a SIBLING with its own `href`, lifted above the
 *     overlay (`z-index: 2`) so it receives its own clicks. That LAYERING, not
 *     the `stopPropagation` below, is what prevents a double navigation — the
 *     two are siblings, so a click on one never reaches the other. The handler
 *     is kept as a belt in case the stacking ever changes.
 * Tab order follows DOM order: app name, then the icon button. Two targets,
 * both reachable, in the order they read.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────
 * Hover lift + press-down, both small (2px / 1.5% scale). Gated on
 * `useReducedMotion()` exactly like `wizardMotion.tsx`: under reduced motion the
 * `.motion` class is simply absent, so the reduced-motion DOM is identical to a
 * plain render and is cheap to assert. The hover half is additionally gated in
 * CSS on `@media (hover: hover) and (pointer: fine)` — on touch, `:hover` sticks
 * after a tap and would leave the tapped tile looking permanently lifted; touch
 * feedback comes from `:active`, which is momentary. See the module's SCSS.
 *
 * ── RECORDING ───────────────────────────────────────────────────────────────
 * BOTH the tile link and the icon button call `onOpenRecent`. For an OFF-SITE
 * entry that click is the only chance to record the open (following the link
 * leaves the SPA); on-site, the run page records it too and the store dedups.
 * Two targets means two places that must record — missing either one silently
 * stops the rail re-ordering for half the ways a viewer uses it.
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
  const reduceMotion = useReducedMotion();
  const target = getRecentRailTarget(entry, { canOpenPage });
  const { action, label: actionLabel } = getRecentRailAction(entry, { canOpenPage });
  const ActionGlyph = RECENT_ACTION_ICONS[action];
  const label = entry.name ?? entry.slug;
  // External targets are https-guarded upstream (`safeExternalHref`) and get the
  // standard new-tab hardening; internal ones route through next/link. Shared by
  // the tile link and the icon button so they can never point at different places.
  //
  // 🔴 `component="a"` on the external branch is LOAD-BEARING for the ActionIcon,
  // not decoration. `Anchor` renders an `<a>` by default so it was fine without
  // it, but `ActionIcon` renders a `<button>` — an `href` on a button is an inert
  // attribute the browser ignores, so the off-site icon CTA rendered as a
  // dead button with a stray `href` and no `role="link"`. It LOOKED correct in
  // the DOM and did nothing on click. Caught by the "an off-site entry → a
  // Visit action" test asserting `getByRole('link', …)`; do not "simplify" this
  // back to a bare `href`.
  const linkProps = target.external
    ? { component: 'a' as const, href: target.href, target: '_blank', rel: 'noopener noreferrer' }
    : { component: Link, href: target.href };

  return (
    <Card
      withBorder
      padding="xs"
      radius="md"
      className={clsx(classes.tile, !reduceMotion && classes.motion)}
      data-testid="apps-recent-rail-tile"
    >
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

        <Anchor
          {...linkProps}
          underline="never"
          c="inherit"
          className={classes.overlayLink}
          data-testid="apps-recent-rail-item"
          onClick={() => onOpenRecent?.(entry)}
        >
          <TruncatedText size="sm" fw={500} lineClamp={1} tooltipLabel={label}>
            {label}
          </TruncatedText>
        </Anchor>

        {/* The icon-only CTA needs a REAL accessible name — the glyph alone is
            not one. `aria-label` supplies it for assistive tech and the `Tooltip`
            supplies the same string visually, the pattern `CategoryFilterButtons`
            established. The label names the app too ("Open Gen Matrix"), so a
            screen-reader user tabbing the rail hears which app each button
            belongs to rather than six identical "Open"s. */}
        <Tooltip label={actionLabel} withArrow>
          <ActionIcon
            {...linkProps}
            variant="subtle"
            color="gray"
            size="md"
            aria-label={actionLabel}
            className={classes.action}
            data-testid="apps-recent-rail-action"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onOpenRecent?.(entry);
            }}
          >
            <ActionGlyph size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Card>
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
