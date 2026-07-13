import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

export type ChallengeBuzzType = 'green' | 'yellow';

// Domain-derived currency: green site → green Buzz, everything else → yellow. Set once at
// creation and stored on the challenge (immutable) — the winner payout reads it back, so unlike
// bounties the challenge can't reconstruct currency from the ledger.
export function deriveDomainCurrency(isGreen: boolean): ChallengeBuzzType {
  return isGreen ? 'green' : 'yellow';
}

// Green (safe-site) challenges must be SFW. Returns true when the pairing is INVALID — green with
// any non-SFW bit set — so the caller rejects. Yellow always passes. Defense-in-depth: the green
// site's rating selector is already SFW-only.
export function isNonSfwForGreen(
  buzzType: ChallengeBuzzType,
  allowedNsfwLevel: number
): boolean {
  return buzzType === 'green' && Flags.intersects(allowedNsfwLevel, nsfwBrowsingLevelsFlag);
}

// A challenge shows only on the domain matching its currency (green on green, yellow off-green).
// The creator is exempt so they can always reach their own, mirroring the scan/POI gates.
export function isChallengeHiddenByDomainCurrency(
  challenge: { buzzType: ChallengeBuzzType; createdById: number | null },
  isGreen: boolean,
  viewerId?: number
): boolean {
  if (challenge.createdById != null && challenge.createdById === viewerId) return false;
  return challenge.buzzType !== deriveDomainCurrency(isGreen);
}
