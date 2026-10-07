import { UserFlag } from '~/shared/constants/user-flags.constants';
import { Flags } from '~/shared/utils/flags';

/** Owner id of system-owned versions; the compensation payout never pays it. */
const SYSTEM_USER_ID = -1;

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
  return ownerId !== SYSTEM_USER_ID && !Flags.hasFlag(ownerFlags ?? 0, UserFlag.DisablePayout);
}

/**
 * A selection is tip-eligible when any selected resource is. `tipsEnabled` absent means "not known"
 * (resource data still loading, or a cache entry from before the field existed) and counts as
 * eligible, so the tip is never withheld on missing data; the submit path re-decides on the server.
 */
export function anyTipEligible(resources: { tipsEnabled?: boolean }[]) {
  return resources.some((r) => r.tipsEnabled !== false);
}
