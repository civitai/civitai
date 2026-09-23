import { ActionIcon, Box, Menu, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconDotsVertical,
  IconEyeOff,
  IconFlag,
  IconMail,
  IconPencil,
  IconRefresh,
  IconShieldCheck,
  IconThumbUp,
} from '@tabler/icons-react';
import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import {
  DETAIL_TAKEDOWN_ACTIONS,
  REVIEW_QUEUE_MANAGE_HREF,
  TAKEDOWN_TESTID_STEM,
  appListingDetailModActions,
  detailModActionLabel,
  type DetailTakedownAction,
} from '~/components/Apps/appListingDetailModActions';
import { canOwnerEditListing, getOwnerEditHref } from '~/components/Apps/appListingCardView';
import { ListingTakedownModal } from '~/components/Apps/ListingTakedownModal';
import { MessageAppOwnerModal } from '~/components/Apps/MessageAppOwnerModal';
import {
  ReportListingModal,
  useCanReportListing,
  useReportListingAffordance,
} from '~/components/Apps/ReportListingModal';
import { ReviewListingModal, useCanReviewListing } from '~/components/Apps/ReviewListingButton';
import {
  type AppListingMenuSurface,
  surfaceOffersViewerActions,
} from '~/components/Apps/appListingMenuSurface';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';

/**
 * App Store Listings — the SHARED `⋮` secondary-action menu, over BOTH listing
 * surfaces (the store CARD and the listing DETAIL body).
 *
 * 🔴 THIS MODULE EXISTS BECAUSE THESE TWO SURFACES HAVE ALREADY DRIFTED ONCE.
 * The CTA glyph mapping was written twice — once on the card and once on the
 * detail — and had to be pulled out into `appListingActionGlyph.ts` after they
 * disagreed; the card's own CTA comment says so in as many words. The menu is a
 * strictly bigger surface to duplicate: an item SET, an ORDER, six labels, four
 * eligibility predicates and four modals whose mount site is load-bearing. So it
 * is written once, here, and both surfaces render THIS component. A second copy
 * is the defect this file is the fix for.
 *
 * WHAT IS PARAMETERISED, and nothing else: the trigger's size / variant / glyph
 * size / `data-testid`, whether the trigger stops click propagation, and — via
 * {@link AppListingMenuSurface} — the ONE item-set difference between the two
 * surfaces. The ORDER, the labels, the eligibility predicates and the modals are
 * identical on both by construction; that is still the point.
 *
 * 🔴 THE ONE DIFFERENCE IS NAMED, CLOSED AND POLICED FROM A SINGLE MODULE, WHICH IS
 * WHAT KEEPS IT FROM BECOMING THE DRIFT THIS FILE EXISTS TO PREVENT. It is not a
 * per-call-site boolean: the caller says WHERE it is (`surface="card"` /
 * `surface="detail"`) and `appListingMenuSurface.ts` decides what that means, so
 * the answer cannot be spelled two ways. Today it decides exactly one thing —
 * whether "Leave a review" and "Report" are offered — and the card says no: those
 * two are about one app the viewer has chosen to look at, and the card is one tile
 * of ~24 being scanned. Everything else, Edit and the whole moderator section
 * included, is the same on both surfaces.
 *
 * 🔴 THE MODALS ARE OWNED HERE, AS SIBLINGS OF THE `Menu`, NOT OF A `Menu.Item`.
 * A Mantine `Menu.Dropdown` is UNMOUNTED when the menu closes, so a modal
 * rendered inside the dropdown is destroyed by the very click that opens it.
 * This is the hard-won rule the detail body carried; moving the menu without
 * moving that rule would have reintroduced the bug on both surfaces at once.
 *
 * 🔴 THE MODALS MOUNT LAZILY — only once the menu has been opened at least once
 * ({@link everOpened}). This is not a micro-optimisation: the store grid renders
 * ~24 of these at a time, and the four modals between them pull the tRPC client
 * (`reportListing` / `upsertReview` / `messageAppOwner` / the takedown pair) and
 * a `matchMedia` subscription each. Mounting them per card would put ~96 modal
 * subtrees and ~24 media-query listeners on a page whose viewer will open at most
 * one of them. Nothing is lost: every one of these modals is reachable ONLY from
 * an item inside this menu, so "the menu has never been opened" implies "no modal
 * can be open". The gates are unchanged — each modal is still `&&`-ed to the same
 * predicate as its trigger.
 */

/** The listing fields this menu needs — satisfied by BOTH `ListingCard` and `ListingDetail`. */
export type AppListingMenuTarget = {
  id: string;
  slug: string;
  /** `'onsite' | 'offsite'` — threaded into the review scope + mod state machine. */
  kind: string;
  /** Only `kind` + `appBlockId` are read (see `getOwnerEditHref`). */
  kindData: { kind: 'onsite'; appBlockId: string | null } | { kind: 'offsite' };
  /** The listing owner's user id, or null when the DTO carries no creator. */
  creatorUserId: number | null;
};

export type AppListingActionsMenuProps = {
  listing: AppListingMenuTarget;
  /**
   * WHICH surface this menu is on — see `appListingMenuSurface.ts` for the single
   * difference it makes and why it is a surface NAME rather than a feature boolean.
   *
   * 🔴 REQUIRED, WITH NO DEFAULT, ON PURPOSE. A default would silently pick one
   * surface's policy for a new call site, and the wrong direction is the expensive
   * one: defaulting to `'detail'` hands the viewer actions to any surface whose
   * author never thought about it. Making it required means `tsc` asks the question
   * at the moment a third surface is added, which is the only moment anyone knows
   * the answer.
   */
  surface: AppListingMenuSurface;
  /**
   * Moderator listing-media review renders a listing READ-ONLY over an
   * UNAPPROVED shadow row. The whole menu is suppressed there — see
   * `appListingDetailModActions.detailListingStatus` for why no action on this
   * surface can be honestly offered against a listing whose status and whose
   * `id` are both unguaranteed.
   */
  preview?: boolean;
  /** Trigger geometry. Defaults are the DETAIL page's (Mantine default size, 20px glyph). */
  triggerSize?: number | string;
  triggerVariant?: string;
  triggerIconSize?: number;
  triggerTestId?: string;
  /** Accessible name for the icon-only trigger. */
  triggerLabel?: string;
  /**
   * Wrap the trigger in a `Tooltip` carrying the same string as its `aria-label`.
   *
   * 🔴 THE `aria-label` IS THE ACCESSIBLE NAME EITHER WAY — the glyph alone is not
   * one (the `CategoryFilterButtons` precedent). The tooltip is the SIGHTED
   * equivalent, and it is opt-in because the two surfaces differ: on the DETAIL
   * page the trigger sits alone in a spacious header, while on the CARD it sits in
   * a dense action row where an unlabelled glyph beside a labelled CTA reads as
   * decoration.
   */
  triggerTooltip?: boolean;
  /**
   * Stop click propagation on the trigger AND the dropdown.
   *
   * 🔴 THE DROPDOWN HALF IS NOT REDUNDANT WITH `withinPortal`. A React portal
   * moves the DOM node, but events still propagate along the REACT tree — so a
   * click inside a portalled dropdown reaches an ancestor's `onClick` exactly as
   * if it were a DOM descendant. On a clickable card that is a navigation the
   * viewer did not ask for, fired by opening a menu.
   */
  stopPropagation?: boolean;
};

/** Everything the menu's visibility and item set depend on, resolved once. */
type AppListingMenuGates = {
  showEdit: boolean;
  editHref: string | null;
  canReview: boolean;
  canReport: boolean;
  modActions: ReturnType<typeof appListingDetailModActions>;
  /** Would the menu hold at least one item? */
  showMenu: boolean;
};

/**
 * The menu's gates, resolved once for the component that renders them.
 *
 * 🔴 THIS USED TO HAVE A SECOND CALLER AND NO LONGER DOES. `useAppListingActionsMenuVisible`
 * exported `showMenu` on its own so the store CARD could lay out around the trigger:
 * the card's action row hid its recommend rollup below a container width derived
 * from how wide the action cluster was, and the trigger's 36px was what made it
 * wide. The rollup now lives in the card's meta block, the container query is gone,
 * and the card's layout is identical whether or not a `⋮` renders — so nothing
 * needs the answer in advance, and the hook was deleted rather than left exported
 * with no consumer. `appListingMenuSurface.test.ts` fails if the card starts
 * branching its layout on menu visibility again.
 *
 * 🔴 STILL WRITTEN ONCE, for the reason that survives: `showMenu` is a four-term
 * disjunction over four separately-defined predicates, and a second copy of that
 * expression anywhere is a predicate duplicated across call sites — the shape that
 * gets fixed at one site and stays wrong at the other.
 *
 * 🔴 DELIBERATELY STATE-FREE. Every input is a pure read of the current user, the
 * feature flags and the mod state machine; nothing here owns a `useDisclosure` or a
 * `useState`. That is what made a second call safe when there was one, and it is
 * what keeps this hook cheap to reuse if a surface ever needs it again.
 */
function useAppListingMenuGates(
  listing: AppListingMenuTarget,
  surface: AppListingMenuSurface,
  preview: boolean
): AppListingMenuGates {
  const currentUser = useCurrentUser();

  // Owner "Edit" deep-link — owner + editable status (both surfaces read an
  // approved-only path that carries no status field → editable); the href builder
  // returns null when there is no editable target (an on-site listing with no
  // backing appBlockId).
  const isOwner = !!currentUser?.id && currentUser.id === listing.creatorUserId;
  const editHref = getOwnerEditHref(listing.kindData, listing.id);
  const showEdit = canOwnerEditListing({ isOwner }) && !!editHref;

  // 🔴 The gates are the SAME predicates each affordance defines, imported rather
  // than re-derived, so the menu cannot disagree with them about who may act.
  // `listing.kind` is threaded in so the review affordance obeys the store-scope
  // kind rule the write gate applies — an external-only viewer is not offered a
  // review control on an onsite listing the server would NOT_FOUND.
  //
  // 🔴 BOTH HOOKS ARE CALLED UNCONDITIONALLY AND THE SURFACE TERM IS APPLIED AFTER.
  // `offersViewerActions && useCanReportListing()` would SHORT-CIRCUIT PAST A HOOK —
  // legal-looking, and a rules-of-hooks violation the moment anything makes the left
  // side vary. The surface is constant per call site today, which is exactly the
  // property that would make such a bug invisible until it was not.
  const offersViewerActions = surfaceOffersViewerActions(surface);
  const viewerMayReview = useCanReviewListing({
    ownerUserId: listing.creatorUserId,
    listingKind: listing.kind as never,
  });
  const viewerMayReport = useCanReportListing();
  // 🔴 THE SURFACE TERM NARROWS; IT NEVER WIDENS. `&&`, so the card can only DROP an
  // item the affordance's own predicate already admitted — an eligibility rule can
  // never be bypassed by naming a surface. See `appListingMenuSurface.ts`.
  const canReview = offersViewerActions && viewerMayReview;
  const canReport = offersViewerActions && viewerMayReport;

  // MODERATOR section. The action SET is derived, never hand-rolled:
  // `appListingDetailModActions` intersects the shared lifecycle state machine
  // (`listingModActions`, which the /apps/review mgmt table also depends on) with
  // the subset these surfaces implement, and answers empty for a non-moderator and
  // in preview. The gate is `isAppReviewer` — the existing named predicate — and it
  // is COSMETIC: every proc behind these items is `moderatorProcedure` plus an
  // inner `isModerator` recheck, which is the actual boundary.
  const modActions = appListingDetailModActions({
    isModerator: isAppReviewer(currentUser),
    preview,
    kind: listing.kind,
  });

  return {
    showEdit,
    editHref,
    canReview,
    canReport,
    modActions,
    // `modActions` is already empty in preview, so the leading `!preview` is not
    // what suppresses the mod section — it is the clause that suppresses the WHOLE
    // menu, on every surface.
    showMenu: !preview && (showEdit || canReview || canReport || modActions.length > 0),
  };
}

/**
 * The `⋮` overflow menu: owner Edit, review, report, and the moderator section.
 *
 * Returns `null` when it would hold NO items — the same predicate the detail body
 * has always applied. Two consequences worth stating because they are decisions:
 *
 *   - a viewer with nothing to do sees no control at all, rather than an empty
 *     menu that punishes the click; and
 *   - the trigger's ~36px therefore enters a surface's layout only for viewers
 *     who have an action. On the store CARD, where the viewer actions are not
 *     offered, that population is exactly the OWNER and a MODERATOR — so those two
 *     get a different action-row geometry from everybody else, signed in or not.
 *     That is accepted (see `AppListingCard`'s action-row note).
 */
export function AppListingActionsMenu({
  listing,
  surface,
  preview = false,
  triggerSize,
  triggerVariant = 'light',
  triggerIconSize = 20,
  triggerTestId = 'apps-listing-actions-menu',
  triggerLabel = 'App options',
  triggerTooltip = false,
  stopPropagation = false,
}: AppListingActionsMenuProps) {
  const { showEdit, editHref, canReview, canReport, modActions, showMenu } = useAppListingMenuGates(
    listing,
    surface,
    preview
  );

  // 🔴 The report affordance's STATE comes from `useReportListingAffordance`, not a
  // bare `useDisclosure`: the server allows one open report per reporter, so once a
  // report lands the trigger has to go spent ("Reported", disabled) or the next
  // click returns a CONFLICT the user reads as a failure. Spread BOTH prop bags —
  // `triggerProps` on the item, `modalProps` on the modal — never hand-roll either.
  const report = useReportListingAffordance();
  const [reviewOpened, reviewModal] = useDisclosure(false);

  const modListing = { appListingId: listing.id, slug: listing.slug, kind: listing.kind };
  const [messageOpened, messageModal] = useDisclosure(false);
  // 🔴 The TAKEDOWN pair shares ONE piece of state holding WHICH action is open,
  // rather than a boolean each. Two booleans can both be true; this cannot, so "the
  // hide confirm and the unpublish confirm are open at once" is unrepresentable
  // instead of merely unlikely — and the two confirms differ only in which mutation
  // they fire, so a viewer seeing both would have no way to tell which one they
  // were about to submit.
  const [takedown, setTakedown] = useState<DetailTakedownAction | null>(null);
  // See the header: the modals mount only after the menu has been opened once.
  const [everOpened, setEverOpened] = useState(false);

  if (!showMenu) return null;

  const stop = stopPropagation ? (e: MouseEvent) => e.stopPropagation() : undefined;

  const trigger = (
    <ActionIcon
      color="gray"
      variant={triggerVariant}
      size={triggerSize}
      aria-label={triggerLabel}
      data-testid={triggerTestId}
      onClick={stop}
    >
      <IconDotsVertical size={triggerIconSize} />
    </ActionIcon>
  );

  return (
    <>
      <Box style={{ flexShrink: 0 }}>
        <Menu
          position="bottom-end"
          transitionProps={{ transition: 'pop-top-right' }}
          withinPortal
          onOpen={() => setEverOpened(true)}
        >
          {/* 🔴 THE `Tooltip` WRAPS `Menu.Target`, NOT THE OTHER WAY ROUND, AND THE
              ORDER IS LOAD-BEARING — the intuitive nesting SILENTLY BREAKS THE
              MENU. `Menu.Target` clones its child to attach the toggle handler and
              its ref; `Tooltip` also clones ITS child and overrides the ref, so
              `Menu.Target > Tooltip > ActionIcon` hands the menu a ref to nothing
              and the trigger stops opening it. Measured, not reasoned: a 2x2 probe
              (tooltip x stopPropagation) in this exact environment passed both
              no-tooltip arms and failed both tooltip-inside arms, with the dropdown
              never mounting. This nesting passes all four.

              ⚠️ SEVERAL OTHER FILES IN THIS REPO USE THE BROKEN ORDER
              (`ComicExportButton`, `GeneratedImageActions`, `DrawingToolbar`, the
              comics page's moderator menus). Out of scope here and NOT fixed — but
              `GeneratedOutputRemixMenu` already carries a comment about the same
              ref hop, so it has been hit before. Do not "tidy" this back. */}
          {triggerTooltip ? (
            <Tooltip label={triggerLabel} withArrow>
              <Menu.Target>{trigger}</Menu.Target>
            </Tooltip>
          ) : (
            <Menu.Target>{trigger}</Menu.Target>
          )}
          <Menu.Dropdown onClick={stop}>
            {/* Owner-only "Edit" deep-link, gated by owner + editable status
                (mod-removed listings hide it). Routes by kind (manifest editor for
                on-site, submit editor for off-site). */}
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
            {/* Review affordance (thumbs/recommend) — hidden for the owner, signed-out
                viewers, AND viewers whose resolved store scope does not admit this
                listing's kind, all by `useCanReviewListing`. The write proc is
                protected + STORE-SCOPE-gated + self-review-blocked server-side.
                🔴 DETAIL SURFACE ONLY — see `appListingMenuSurface.ts`. */}
            {canReview && (
              <Menu.Item
                leftSection={<IconThumbUp size={14} stroke={1.5} />}
                onClick={reviewModal.open}
                data-testid="apps-listing-review-action"
              >
                Leave a review
              </Menu.Item>
            )}
            {/* Report affordance — the proc is protected + rate-limited +
                reporter-bound server-side. 🔴 DETAIL SURFACE ONLY (see
                `appListingMenuSurface.ts`): `useCanReportListing` is
                `!!useCurrentUser()`, so on the card this item alone would give every
                signed-in shopper a menu — which is the geometry regression the
                surface gate exists to stop.
                🔴 `triggerProps` carries BOTH the click
                and the spent `disabled` state; the modal below carries its
                `onReported` counterpart. The pair is what stops a second report
                returning the server's one-open-report-per-reporter CONFLICT as an
                error toast. */}
            {canReport && (
              <Menu.Item
                color="red"
                leftSection={<IconFlag size={14} stroke={1.5} />}
                {...report.triggerProps}
                data-testid="apps-listing-report-action"
              >
                {report.label}
              </Menu.Item>
            )}
            {/* MODERATOR section — divided and labelled so a mod action is never one
                slot away from a reader's "Leave a review". The set comes from
                `appListingDetailModActions`; the ORDER is that function's (Contact
                before the lifecycle action), and the review-queue link is last
                because it navigates away rather than acting. */}
            {modActions.length > 0 && (
              <>
                <Menu.Divider />
                <Menu.Label>Moderator</Menu.Label>
                {modActions.includes('message-owner') && (
                  <Menu.Item
                    leftSection={<IconMail size={14} stroke={1.5} />}
                    onClick={messageModal.open}
                    data-testid="apps-listing-mod-message-owner"
                  >
                    {detailModActionLabel('message-owner')}
                  </Menu.Item>
                )}
                {/* The TAKEDOWN pair, rendered by mapping the canonical order rather
                    than as two hand-written branches: the two items differ only in
                    which action they carry, so writing them out twice is how one of
                    them ends up wired to the other's label or testid. Each still
                    renders only if `modActions` admits it. */}
                {DETAIL_TAKEDOWN_ACTIONS.filter((a) => modActions.includes(a)).map((action) => (
                  <Menu.Item
                    key={action}
                    color="red"
                    leftSection={
                      action === 'hide' ? (
                        <IconEyeOff size={14} stroke={1.5} />
                      ) : (
                        <IconRefresh size={14} stroke={1.5} />
                      )
                    }
                    onClick={() => setTakedown(action)}
                    data-testid={`${TAKEDOWN_TESTID_STEM[action]}-menu-item`}
                  >
                    {detailModActionLabel(action)}
                  </Menu.Item>
                ))}
                {/* 🔴 THE INVERSE AFFORDANCE, AND IT IS A LINK RATHER THAN A BUTTON ON
                    PURPOSE. There is no relist/republish control here because there
                    cannot be one: `relistListing` acts on a `removed` listing, both
                    surfaces read approved-only, and a removed listing 404s before
                    either mounts. So the honest way back is the surface that CAN see
                    a removed listing — the /apps/review mgmt table, which already
                    carries Relist (and Claim/Purge) for exactly that state.

                    🔴 THE `?tab=manage` IS LOAD-BEARING — a bare `/apps/review`
                    resolves to the PENDING tab, and Relist is on the manage tab. The
                    href is a named constant so the destination this menu promises is
                    pinned in the blocking tier rather than typed inline. */}
                <Menu.Item
                  component={Link}
                  href={REVIEW_QUEUE_MANAGE_HREF}
                  leftSection={<IconShieldCheck size={14} stroke={1.5} />}
                  data-testid="apps-listing-mod-manage"
                >
                  Manage in review queue
                </Menu.Item>
              </>
            )}
          </Menu.Dropdown>
        </Menu>
      </Box>

      {/* The action modals, mounted OUTSIDE the dropdown — see the header. Each is
          gated by the same predicate as its menu item, so an ineligible viewer
          mounts neither the trigger nor the form. `preview` needs no clause of its
          own here: this whole subtree is unreachable when `showMenu` is false, and
          `showMenu` carries `!preview`. */}
      {everOpened && (
        <>
          {canReview && (
            <ReviewListingModal
              appListingId={listing.id}
              opened={reviewOpened}
              onClose={reviewModal.close}
            />
          )}
          {canReport && <ReportListingModal appListingId={listing.id} {...report.modalProps} />}
          {/* `MessageAppOwnerModal` is REUSED, not forked: it names no recipient by
              design (the owner is resolved server-side, and for an on-site listing
              that resolution can disagree with the listing's own `userId` column). */}
          {modActions.includes('message-owner') && (
            <MessageAppOwnerModal
              listing={messageOpened ? modListing : null}
              onClose={messageModal.close}
            />
          )}
          {/* ONE takedown confirm, for whichever of the pair is open. Mounted only
              when `modActions` still admits that action, so the state alone cannot
              open a confirm for something this viewer or this listing state does not
              offer. */}
          {takedown && modActions.includes(takedown) && (
            <ListingTakedownModal
              action={takedown}
              listing={modListing}
              onClose={() => setTakedown(null)}
            />
          )}
        </>
      )}
    </>
  );
}
