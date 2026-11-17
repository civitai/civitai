import { ListingPermissionsDisclosure } from '~/components/Apps/ListingPermissionsDisclosure';
import { connectScopePermissions } from '~/components/Apps/listingPermissions';

/**
 * ConnectScopesDisclosure — the PUBLIC store-page enumeration of the account
 * permissions an OAuth-connect off-site listing is APPROVED TO ASK FOR, shown
 * BEFORE the viewer clicks Connect.
 *
 * 🔴 WHAT A MODERATOR REVIEWED — NEITHER A PROMISE NOR A CEILING. See the "MAY
 * request" comment on the heading below for why every string here is deliberately
 * hedged; the short version is that `connectRequestedScopes` is review-only and does
 * not gate token issuance.
 *
 * 🔴 WHY THIS EXISTS: the store page already tells a viewer that an off-site app
 * "can connect to your Civitai account", and then said nothing about what it
 * would ask for — while the ON-SITE surface enumerates its approved scopes in
 * full (#4761). So the surface granting the WEAKER capability disclosed more than
 * the one granting real account access. Measured in production when this shipped:
 * of the listings carrying a connect client, the requested masks included
 * `UserRead` (profile, settings & email), `BuzzRead` (balance & history),
 * `AIServicesWrite` (Buzz spend) and in one case `VaultRead` (the user's private
 * model vault) — none of it disclosed anywhere the viewer could see it.
 *
 * 🔴 IT RENDERS THE SHARED `ListingPermissionsDisclosure`, NOT A SECOND RENDERER.
 * This file is only the connect ADAPTER: it turns TokenScope keys into rows
 * (`connectScopePermissions`) and supplies the hedged heading below. The grouping,
 * the order and the row look are the same component an on-site app's permissions
 * render through, so the two listing shapes cannot read differently. The
 * `SensitiveScopeBadge` emphasis is still the same badge the
 * moderator review surface (`ConnectScopesPanel`) renders.
 *
 * 🔴 IT CANNOT DISCLOSE `connectScopeJustifications`, BY CONSTRUCTION. That text
 * is authored by the app owner and publishing it is a separate exposure decision
 * that has not been made. This component takes no justifications prop and the
 * row model has no field for the text, so the omission is structural rather than
 * a convention someone later forgets.
 *
 * 🔴 NOT the mutually-exclusive off-site pair. `shouldShowOffsiteDisclosure` and
 * `shouldShowConnectCapability` are exact complements over one domain and their
 * never-both-never-neither invariant is pinned in
 * `__tests__/appListingDetailView.test.ts`. This is a THIRD surface that follows
 * the connect-capability sentence and enumerates it; do not fold it into either
 * predicate, exactly as the on-site scopes section must not be folded in.
 *
 * Rendered only when there is something to disclose — the caller guards on
 * `length > 0`, matching the on-site section, so a listing that requests nothing
 * gets no section rather than a reassuring empty box.
 */
export function ConnectScopesDisclosure({
  scopes,
  preview = false,
}: {
  scopes: string[];
  /**
   * 🔴 MODERATOR PREVIEW — a CORRECTNESS FIX, NOT COPY, and the on-site sibling
   * carries the identical one for the identical reason.
   *
   * `getListingPreviewForReview` is deliberately NOT status-filtered, so this card
   * also renders for a listing UNDER REVIEW — including a shadow revision that is
   * ESCALATING its scopes. In that posture the public wording ("a moderator
   * reviewed these") states the reviewer's own conclusion back at them as though it
   * were already reached, which is precisely how an escalation gets under-read on
   * the one surface where that call is made. See the `preview` heading note on the
   * on-site permission section for the case that established this.
   */
  preview?: boolean;
}) {
  const permissions = connectScopePermissions(scopes);
  // 🔴 "MAY request" — not "will request", and not a ceiling. `connectRequestedScopes`
  // is a review-time snapshot of the client's `allowedScopes` that does NOT gate token
  // issuance (`offsite-listing.service.ts`). The consent screen lists the `?scope=` asked
  // for at authorize time, usually a SUBSET of this; and an owner can widen
  // `allowedScopes` afterwards (`oauth-client.router.ts` update, unmoderated) without
  // re-snapshotting, so the runtime set can also EXCEED it. This list is what a moderator
  // reviewed; the sign-in screen is what binds. Do not tighten the wording either way.
  return (
    <ListingPermissionsDisclosure
      permissions={permissions}
      testId="connect-scopes-disclosure"
      title={
        preview
          ? `Permissions requested in this submission (${permissions.length})`
          : `Permissions this app may request (${permissions.length})`
      }
      info={
        preview
          ? 'The scopes THIS submission declares — the set you are being asked to approve, not one already approved. Compare it against what the listing currently discloses before approving an escalation.'
          : "The permissions a moderator reviewed for this app. When you connect it you'll be taken to a Civitai sign-in screen listing what it is actually requesting at that moment — always check that screen, since it is what you are approving. You can disconnect the app at any time."
      }
    />
  );
}
