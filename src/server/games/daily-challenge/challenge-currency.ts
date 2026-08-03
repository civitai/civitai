import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { deriveChallengeNsfwLevel } from '~/server/games/daily-challenge/daily-challenge.utils';

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

// A user challenge shows only on the domain matching its currency (green on green, yellow
// off-green). Only user-created challenges are domain-scoped: System/mod/event challenges are
// prize-only (no entry fee) and universal — a green user can win their yellow Buzz and spend it on
// the mature site — so they show on both domains, like the scan/POI gates. The creator is exempt
// so they can always reach their own.
export function isChallengeHiddenByDomainCurrency(
  challenge: { source: ChallengeSource; buzzType: ChallengeBuzzType; createdById: number | null },
  isGreen: boolean,
  viewerId?: number
): boolean {
  if (challenge.source !== ChallengeSource.User) return false;
  if (challenge.createdById != null && challenge.createdById === viewerId) return false;
  return challenge.buzzType !== deriveDomainCurrency(isGreen);
}

export type NsfwEscalation = {
  allowedNsfwLevel: number;
  nsfwLevel: number;
  cancel: boolean;
};

// Decide how a scanned challenge escalates. A clean scan just recomputes the display level from the
// (unchanged) allowed mask. An NSFW verdict on a green USER challenge cancels it (green must be SFW —
// the caller voids + refunds). An NSFW verdict on a yellow/non-user challenge raises the rating to R so
// it drops out of safe feeds while staying live.
export function computeNsfwEscalation(input: {
  allowedNsfwLevel: number;
  buzzType: ChallengeBuzzType;
  source: ChallengeSource;
  isNsfw: boolean;
}): NsfwEscalation {
  const cancel =
    input.isNsfw && input.source === ChallengeSource.User && input.buzzType === 'green';
  if (!input.isNsfw || cancel) {
    return {
      allowedNsfwLevel: input.allowedNsfwLevel,
      nsfwLevel: deriveChallengeNsfwLevel(input.allowedNsfwLevel),
      cancel,
    };
  }
  const allowedNsfwLevel = Flags.addFlag(input.allowedNsfwLevel, NsfwLevel.R);
  return {
    allowedNsfwLevel,
    nsfwLevel: deriveChallengeNsfwLevel(allowedNsfwLevel),
    cancel: false,
  };
}
