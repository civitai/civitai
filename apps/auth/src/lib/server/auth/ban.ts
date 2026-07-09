// Loosely-typed ban-detail handling for the hub producer. We intentionally do NOT vendor the main app's
// strict `BanReasonCode` enum or its reason→label table — that's duplicated, drift-prone data, and the
// public-label mapping is presentation logic the main app owns. The hub carries the raw values as strings.
//
// (In practice the session's `banDetails` is ~always undefined: the main app strips `banDetails` out of
// `meta` before reading it — produceSessionUser reproduces that for parity. So this stays minimal.)

export interface BanDetailsMeta {
  reasonCode?: string;
  detailsInternal?: string;
  detailsExternal?: string;
}

export interface UserBanDetails {
  banReasonCode?: string;
  bannedReasonDetails?: string;
}

/**
 * Mirrors the main app's `getUserBanDetails`, loosely typed. `banReasonCode` is moderator-only; the public
 * reason LABEL is deliberately not computed here (the main app owns that mapping). Undefined when there's
 * no ban metadata.
 */
export function getUserBanDetails({
  meta,
  isModerator,
}: {
  meta?: { banDetails?: BanDetailsMeta };
  isModerator?: boolean;
}): UserBanDetails | undefined {
  const banDetails = meta?.banDetails;
  if (!banDetails) return;

  const result: UserBanDetails = {
    banReasonCode: isModerator ? banDetails.reasonCode : undefined,
    bannedReasonDetails: banDetails.detailsExternal,
  };
  for (const k of Object.keys(result) as (keyof UserBanDetails)[]) {
    if (result[k] === undefined) delete result[k];
  }
  return result;
}
