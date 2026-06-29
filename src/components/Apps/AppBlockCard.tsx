import { Anchor, Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import {
  IconExternalLink,
  IconPlugConnected,
  IconSettings,
  IconStarFilled,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { AppDetailsModal } from '~/components/Apps/AppDetailsModal';
import {
  CATEGORY_ICONS,
  FALLBACK_CATEGORY_ICON,
} from '~/components/Apps/marketplaceCategoryIcons';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORY_LABELS,
} from '~/server/services/blocks/marketplace-categories.constants';
import { hasInstallSlot } from '~/shared/constants/slot-registry';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * Marketplace card for an approved app block. Renders the block name,
 * a short description (from manifest.description), the mod-assigned category,
 * and the action CTAs (View details / Open app / Install/Manage).
 *
 * Round-2 marketplace pass (2026-06): the slot/location badge and the
 * "by {author}" attribution line were dropped from the card face (the launch
 * is page-only, so the slot badge is noise) — both still live on the detail
 * page / modal. "View details" is a link-style (subtle) button.
 *
 * The install CTA opens the per-app settings panel; we delegate the open
 * action to the parent via `onOpen` so the page owns the modal lifecycle.
 */
export interface AppBlockCardProps {
  block: AvailableBlock;
  alreadySubscribed: boolean;
  onOpen: (block: AvailableBlock) => void;
  /**
   * Lifetime publisher share for this app, in cents. Rendered as an
   * "Earning" chip on cards owned by the current user. Undefined =
   * not owned by the viewer; 0 = owned but no earnings yet (no chip).
   */
  ownedEarningCents?: number;
  /**
   * W10 — whether the viewer can open a full-page app (the `appBlocksPages`
   * flag). When true AND the app declares a page (`manifest.hasPage`), an
   * "Open app" link to `/apps/run/<slug>` is shown. Dark today (flag mod-only).
   */
  canOpenPage?: boolean;
  /**
   * M1 — record a "recently opened" entry for THIS block. Called from the
   * card's route-open paths (the "Open app" link + the title/description
   * detail-page links) so a PAGE app — which never fires the install `onOpen`
   * (it has no install slot) — still populates the "Recently opened" strip on
   * its main open path. Fire-and-navigate: a sync onClick doesn't block the
   * `<Link>` navigation. Optional so existing callers (and tests) that don't
   * track recents are unaffected.
   */
  onRecentOpen?: (block: AvailableBlock) => void;
}

/**
 * Maps a stored category value to its display label. Falls back to the raw
 * value for an unrecognised category (soft contract — adding a category is a
 * one-line const edit, and an older client won't crash on a newer category).
 */
function categoryLabel(category: string): string {
  return isMarketplaceCategory(category) ? MARKETPLACE_CATEGORY_LABELS[category] : category;
}

/**
 * Per-category icon. The category taxonomy is the structured free-text
 * `app_blocks.category` column (the MARKETPLACE_CATEGORIES single-source const);
 * `CATEGORY_ICONS` (the SHARED single-source map in `marketplaceCategoryIcons.ts`,
 * also used by the filter buttons) maps each known value to a Tabler icon. An
 * unknown/legacy category (or NULL, handled by the caller) falls back to a
 * generic tag icon so the chip never breaks on a newer category.
 */
function categoryIcon(category: string): Icon {
  return isMarketplaceCategory(category) ? CATEGORY_ICONS[category] : FALLBACK_CATEGORY_ICON;
}

export function AppBlockCard({
  block,
  alreadySubscribed,
  onOpen,
  ownedEarningCents,
  canOpenPage,
  onRecentOpen,
}: AppBlockCardProps) {
  const manifest = block.manifest as {
    name?: string;
    description?: string;
    targets?: Array<{ slotId?: string }>;
    hasPage?: boolean;
  };
  const [busy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Off-site (external-link) app — PURE EXTERNAL LINK. When `externalUrl` is set
  // the card renders an "Open ↗" link to the off-site URL (new tab) and HIDES
  // the Install button + (already-card-hidden) scopes, since an external app has
  // no install / scopes / token. The off-site nature is flagged with a small
  // "Off-site" badge. Everything else (View details) is unchanged.
  const isExternal = Boolean(block.externalUrl);
  // Show Install ONLY for an app that installs into a model/in-context slot.
  // A page app (target slot `app.page`) is STATELESS — installModel `'none'` in
  // the slot registry — so it has no `block_user_subscriptions` install row and
  // the Install/Manage CTA (openAppSettingsModal → slot subscription) is a
  // dead/forbidden action for it (slot installs are server-gated dark, #2622).
  // `hasInstallSlot` is the SHARED predicate (with the detail page) — it scans
  // ALL targets for ANY non-page slot, so it's correct for multi-target and
  // empty-slotId manifests, not just index `[0]`. Keyed on the APP's slot, not
  // the viewer — so a model-slot app still shows Install for the grandfathered
  // mod audience.
  // An external-link app NEVER installs (no install slot, no subscription) — so
  // suppress Install even if a stray manifest target slipped through.
  const showInstall = !isExternal && hasInstallSlot(manifest);
  // The live "Open app" run is only available for a real page app that the
  // viewer's `appBlocksPages` flag has unlocked (dark today / launch-flip
  // window). Never for an external app (it hosts no on-platform page).
  const canOpenApp = !isExternal && Boolean(manifest.hasPage && canOpenPage);
  // INVARIANT (never-empty card): "View details" is the UNIVERSAL details
  // affordance — it is rendered on EVERY card (page app, model app, flag on or
  // off), so the card can never be actionless. It supersedes the #2747
  // page-link "View" fallback (a detail-page link shown only when no Install /
  // Open app rendered): the modal covers that case for every card now, and the
  // modal itself exposes "Open live"/the detail data, so we don't strand the
  // user. "Open app" / Install remain the RUN/INSTALL affordances on top of it.
  return (
    <Card shadow="sm" padding="md" radius="md" withBorder className="h-full">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            {/*
              F-E E2: the card title links to the per-app detail page
              (/apps/<appBlockId>). Install stays the secondary action below.
            */}
            <Anchor
              component={Link}
              href={`/apps/${block.id}`}
              underline="never"
              c="inherit"
              // M1: navigating to the detail page IS opening the app — record it
              // to recents. Fire-and-navigate (sync onClick won't block <Link>).
              onClick={() => onRecentOpen?.(block)}
            >
              <Title order={4} className="line-clamp-2">
                {manifest.name ?? block.blockId}
              </Title>
            </Anchor>
          </Stack>
          <Stack gap={4} align="flex-end">
            {/* Off-site (external-link) app badge — makes it visually clear the
                card opens an external, off-platform site rather than an
                installable/in-page app. */}
            {isExternal && (
              <Badge
                variant="light"
                color="blue"
                size="sm"
                leftSection={<IconExternalLink size={12} />}
              >
                Off-site
              </Badge>
            )}
            {/* Mod-assigned marketplace category (+ its icon). NULL until a mod
                sets one → no chip. The icon comes from CATEGORY_ICONS (generic
                tag fallback for an unknown/legacy value). */}
            {block.category &&
              (() => {
                const CategoryIcon = categoryIcon(block.category);
                return (
                  <Badge
                    variant="light"
                    color="grape"
                    size="sm"
                    leftSection={<CategoryIcon size={12} />}
                  >
                    {categoryLabel(block.category)}
                  </Badge>
                );
              })()}
            {ownedEarningCents != null && ownedEarningCents > 0 && (
              <Badge variant="light" color="green" size="sm">
                Earning ${(ownedEarningCents / 100).toFixed(2)}
              </Badge>
            )}
          </Stack>
        </Group>
        {manifest.description && (
          <Anchor
            component={Link}
            href={`/apps/${block.id}`}
            underline="never"
            c="inherit"
            // M1: the description link is a detail-page open too — record it.
            onClick={() => onRecentOpen?.(block)}
          >
            <Text size="sm" c="dimmed" className="line-clamp-3">
              {manifest.description}
            </Text>
          </Anchor>
        )}
        {/* Scopes were MOVED off the card face into the details modal (2026-06
            UX pass) — the permission disclosure now lives under "View details"
            so the card stays scannable. */}
        <Group justify="space-between" mt="auto" pt="xs">
          <Group gap={10}>
            {/* Install count is HIDDEN until there's a real user base — every
                app currently shows 0, which reads as "unused". Re-introduce when
                installs are meaningful. */}
            {/* Review indicator: shown ONLY when the app has ≥1 review. A
                0-review app shows nothing (no "No reviews" affordance) so an
                un-reviewed app doesn't look bad. */}
            {block.reviewCount > 0 && block.avgRating != null && (
              <Group gap={4}>
                <IconStarFilled size={13} className="text-yellow-500" />
                <Text size="xs" c="dimmed">
                  {block.avgRating.toFixed(1)} ({block.reviewCount.toLocaleString()})
                </Text>
              </Group>
            )}
          </Group>
          {/*
            Anon-conversion CTA (F-E E1): for a session-less viewer, clicking
            Install opens the LoginModal (via LoginRedirect → requireLogin →
            dialogStore.trigger(LoginModal, { returnUrl })) instead of the
            install/settings modal — installing requires auth. For a logged-in
            viewer LoginRedirect is a pass-through and the onClick runs
            normally. This is dark today (the page is mod-gated); it only
            matters once the segment is widened to anon.
          */}
          <Group gap={6} wrap="nowrap">
            {/* "View details" — the UNIVERSAL details affordance, on EVERY card
                (this is what guarantees the never-empty-card invariant; it
                supersedes the #2747 page-link "View" fallback). Opens the
                details modal (description, screenshots, recent reviews, scopes).
                A button, not a link, so it doesn't navigate away from the grid.
                Styled link-subtle (variant="subtle") — round-2 marketplace pass:
                de-emphasised vs the filled Install/Open-app run affordances. */}
            <Button size="xs" variant="subtle" onClick={() => setDetailsOpen(true)}>
              View details
            </Button>
            {/* Off-site (external-link) app: an "Open ↗" link that opens the
                external URL in a NEW TAB. Replaces the Install/Open-app run
                affordances entirely for an external app (which has no install /
                on-platform page). target=_blank + rel=noopener noreferrer. */}
            {isExternal && block.externalUrl && (
              <Button
                component="a"
                href={block.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                variant="light"
                rightSection={<IconExternalLink size={14} />}
                // Recording an off-site open as a "recent" is reasonable, but
                // fire-and-navigate semantics differ for a new tab — keep parity
                // with the route links above.
                onClick={() => onRecentOpen?.(block)}
              >
                Open
              </Button>
            )}
            {/* W10 — "Open app" link to the full-page route, shown only when the
                app declares a page AND the viewer has the appBlocksPages flag
                (dark today). The route itself 404s without the flag, so this is
                belt-and-suspenders against showing a dead link. */}
            {canOpenApp && (
              <Button
                component={Link}
                href={`/apps/run/${encodeURIComponent(block.blockId)}`}
                size="xs"
                variant="light"
                // M1: the live "Open app" route is the PRIMARY open path for a
                // page app (which never fires the install `onOpen`) — record it
                // to recents. Fire-and-navigate (sync onClick won't block <Link>).
                onClick={() => onRecentOpen?.(block)}
              >
                Open app
              </Button>
            )}
            {showInstall && (
              <LoginRedirect reason="perform-action">
                <Button
                  size="xs"
                  variant={alreadySubscribed ? 'default' : 'filled'}
                  leftSection={
                    alreadySubscribed ? <IconSettings size={14} /> : <IconPlugConnected size={14} />
                  }
                  loading={busy}
                  onClick={() => onOpen(block)}
                >
                  {alreadySubscribed ? 'Manage' : 'Install'}
                </Button>
              </LoginRedirect>
            )}
          </Group>
        </Group>
      </Stack>
      {/* Details modal — controlled by this card's local state. GATED so the
          whole subtree (its tRPC query hooks + the <AppBlockReviews> subtree)
          only EXISTS while open: with N cards in the marketplace grid, an
          always-mounted modal per card meant N idle modal instances. The "View
          details" BUTTON above stays unconditional (the never-empty-card
          invariant) — only this subtree is gated. */}
      {detailsOpen && (
        <AppDetailsModal opened onClose={() => setDetailsOpen(false)} block={block} />
      )}
    </Card>
  );
}
