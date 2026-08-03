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
import Link from 'next/link';
import clsx from 'clsx';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { ACTION_GLYPH_ICONS, recentRailActionGlyph } from '~/components/Apps/appListingActionGlyph';
import {
  getRecentRailAction,
  getRecentRailTarget,
  type ResolvedRecentApp,
} from '~/components/Apps/recentAppsRail';

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
 * Recents-tile styling, as Tailwind class strings rather than a CSS module.
 *
 * 🔴 NOT A STYLE PREFERENCE — a CSS-module import here BREAKS the browser test
 * suite. `RecentlyOpenedApps.browser.test.tsx` and
 * `RecentlyOpenedApps.reducedMotion.browser.test.tsx` both `await import()` this
 * module in the same Vitest browser worker (the second one has to be its own
 * file because it needs a module-level `vi.mock('@mantine/hooks')`). With a
 * `./RecentlyOpenedApps.module.scss` import present, the second file
 * deterministically fails to load — "Failed to fetch dynamically imported
 * module: .../RecentlyOpenedApps.tsx" — and its 4 tests silently vanish from the
 * run while the reported count still reads "passed". Measured: the pair is
 * 16/20 with the SCSS import and 20/20 without it, with no other change. The
 * sibling `ExternalSubmitForm` reduced-motion pair works precisely because that
 * component has no CSS module.
 *
 * Everything below needs real CSS (a `::after` overlay, a hover media gate) that
 * inline styles cannot express, so Tailwind — already used throughout this file
 * (`line-clamp-1`, `opacity-60`) — is the substitute.
 */

/** The tile. `relative` is the containing block for the `after:` overlay below. */
const TILE_CLASS = 'relative';

/**
 * The MOTION layer, applied only when the viewer has not asked for reduced
 * motion (the component short-circuits with `useReducedMotion`, so under reduced
 * motion this class string is absent and the DOM is identical to a plain render
 * — the `wizardMotion.tsx` precedent). The `motion-reduce:` utilities are a belt
 * for the case where the media query resolves but the hook's value has not
 * propagated yet.
 *
 * 🔴 HOVER IS GATED ON `(hover: hover)` via an arbitrary variant, NOT plain
 * `hover:`. Tailwind only compiles `hover:` to a hover-capability media query
 * when `hoverOnlyWhenSupported` is on, and this repo does not set it — so a bare
 * `hover:-translate-y-0.5` would STICK after a tap on a touch device and leave
 * the tapped tile looking permanently lifted, which reads as selected state
 * rather than as feedback. `(pointer: fine)` additionally excludes hybrid
 * devices being driven by touch. Touch gets `active:`, which is momentary and
 * fires for both input types — it is the one affordance a touch viewer gets, so
 * it is deliberately NOT behind the hover gate.
 */
const TILE_MOTION_CLASS = [
  'transition-[transform,box-shadow,border-color] duration-150 ease-out',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-0.5',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:shadow-md',
  'active:translate-y-0 active:scale-[0.985] active:duration-75',
  'motion-reduce:transition-none motion-reduce:transform-none',
].join(' ');

/**
 * The tile-wide link. The visible app name is the anchor's own text — so it has
 * a real accessible name — and the `after:` pseudo-element stretches that same
 * anchor over the whole card, which is what makes the tile clickable anywhere
 * WITHOUT nesting interactive elements.
 *
 * `flex-1` so the name claims the leftover width and the icon CTA is pushed to
 * the tile's right edge; without it the anchor is content-sized and the CTA
 * lands at a different horizontal position on every tile, which reads as
 * misalignment across the rail. `min-w-0` is what lets the name shrink (and
 * therefore truncate) instead of forcing the tile wider.
 */
const TILE_LINK_CLASS =
  "min-w-0 flex-1 after:absolute after:inset-0 after:z-[1] after:rounded-[inherit] after:content-['']";

/**
 * The icon CTA. A SIBLING of the tile link, lifted ABOVE the overlay's `z-1` so
 * it receives its own pointer events instead of the overlay swallowing them.
 * This is what makes the two targets independent: a click here never reaches the
 * tile link, so there is no double navigation.
 */
const TILE_ACTION_CLASS = 'relative z-[2] shrink-0';

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
 * feedback comes from `:active`, which is momentary. See TILE_MOTION_CLASS.
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
  // 🔴 SINGLE-SOURCED. This tile used to carry its own private
  // `RECENT_ACTION_ICONS` record — the third copy of a glyph mapping
  // `appListingActionGlyph.ts` already owned for the store card and the listing
  // detail, and the one `AppListingCard`'s CTA comment named as the outstanding
  // consolidation. Resolve through `recentRailActionGlyph` so the rail, the card
  // and the detail page cannot drift: an eye here and an eye there are now the
  // same lookup, not two literals that happen to agree today.
  const ActionGlyph = ACTION_GLYPH_ICONS[recentRailActionGlyph(action)];
  const label = entry.name ?? entry.slug;
  // External targets are https-guarded upstream (`safeExternalHref`) and get the
  // standard new-tab hardening; internal ones route through next/link. `Anchor`
  // renders an `<a>` by default, so the external branch needs no `component`.
  const anchorProps = target.external
    ? { href: target.href, target: '_blank', rel: 'noopener noreferrer' }
    : { component: Link, href: target.href };

  return (
    <Card
      withBorder
      padding="xs"
      radius="md"
      className={clsx(TILE_CLASS, !reduceMotion && TILE_MOTION_CLASS)}
      data-testid="apps-recent-rail-tile"
      // An EXPLICIT marker for the reduced-motion test rather than grepping the
      // class list for a substring: `TILE_MOTION_CLASS` legitimately contains
      // `motion-reduce:` utilities, so a `/motion/` match on the class string
      // would be true for the wrong reason and would keep passing if the real
      // transition utilities were deleted.
      data-motion={reduceMotion ? 'reduced' : 'on'}
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
          {...anchorProps}
          underline="never"
          c="inherit"
          className={TILE_LINK_CLASS}
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
        {/* 🔴 THE ICON CTA MUST RENDER AN `<a>`, and `renderRoot` is how.
            `ActionIcon` renders a `<button>` by default. Passing it a bare
            `href` (the shape the tile `Anchor` accepts) produced a BUTTON with
            a stray `href` attribute the browser ignores: no `role="link"`, no
            navigation, nothing on click. It looked plausible in the DOM —
            `<button href="https://…">` — and only the OFF-SITE tiles were
            affected, since the internal branch passed `component={Link}`. The
            test that caught it asserts the ROLE
            (`getByRole('link', { name: 'Visit …' })`); an
            `toHaveAttribute('href', …)` assertion would have passed on the
            broken build.

            `renderRoot` rather than the polymorphic `component=` prop for the
            reason `AppsSubNav` documents: mounting a typed Next `<Link>` (or
            branching the root element at all) through `component=` produces a
            generic-component TS2322, because the two branches are a union of
            two different polymorphic prop shapes. `renderRoot` keeps the root
            element's typing local to the element itself. */}
        <Tooltip label={actionLabel} withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="md"
            aria-label={actionLabel}
            className={TILE_ACTION_CLASS}
            data-testid="apps-recent-rail-action"
            /**
             * 🔴 `type` IS DESTRUCTURED OUT ON PURPOSE. `UnstyledButton` sets
             * `type: component === 'button' ? 'button' : undefined` and `Box`
             * forwards it into `renderRoot(props)` — but it computes that BEFORE
             * `renderRoot` swaps the root element, so it still thinks the root is
             * a `<button>` and we get `<a type="button">`. On an anchor `type` is
             * the MIME-type hint of the linked resource, and `"button"` is not a
             * valid MIME type: inert, but invalid HTML, and the same
             * "props leaked into the wrong root element" family as the dead-button
             * bug this branch already shipped once.
             */
            renderRoot={({ type: _dropButtonType, ...props }) =>
              target.external ? (
                <a {...props} href={target.href} target="_blank" rel="noopener noreferrer" />
              ) : (
                <Link {...props} href={target.href} />
              )
            }
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
