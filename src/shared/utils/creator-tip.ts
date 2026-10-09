import { constants } from '~/server/common/constants';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Whether a resource's owner can receive a share of the creator tip. A licensing fee does NOT make a
 * resource ineligible: fee creators still get tips, only their base compensation is suppressed.
 */
export function isCreatorTipEligible({
  ownerId,
  ownerFlags,
}: {
  ownerId: number;
  ownerFlags: number | null | undefined;
}) {
  // The compensation payout never pays the system user.
  return (
    ownerId !== constants.system.user.id && !Flags.hasFlag(ownerFlags ?? 0, UserFlag.DisablePayout)
  );
}

/**
 * A selection is tip-eligible when any selected resource is. `tipsEnabled` absent means "not known"
 * (resource data still loading, or a cache entry from before the field existed) and counts as
 * eligible, so the tip is never withheld on missing data; the submit path re-decides on the server.
 */
export function anyTipEligible(resources: { tipsEnabled?: boolean }[]) {
  return resources.some((r) => r.tipsEnabled !== false);
}
