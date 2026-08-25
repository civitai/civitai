import { banReasonDetails } from '~/server/common/constants';
import type { BanReasonCode } from '~/server/common/enums';
import type { UserMeta } from '~/server/schema/user.schema';
import { removeEmpty } from '~/utils/object-helpers';

export type UserBanDetails = {
  banReasonCode?: BanReasonCode;
  banReason?: string;
  bannedReasonDetails?: string;
};

export const getUserBanDetails = ({
  meta,
  isModerator,
}: {
  meta?: UserMeta;
  isModerator?: boolean;
}): UserBanDetails | undefined => {
  if (!meta?.banDetails) return;
  const { banDetails } = meta;

  return removeEmpty({
    banReasonCode: isModerator ? banDetails?.reasonCode : undefined,
    banReason: banDetails?.reasonCode
      ? // `meta` is JSON, never parsed against the enum, so a build predating a reason code reads one
        // it has no entry for — unguarded that throws inside `getUserWithProfile` and 500s the profile.
        banReasonDetails[banDetails.reasonCode]?.publicBanReasonLabel
      : undefined,
    bannedReasonDetails: banDetails?.detailsExternal,
  });
};
