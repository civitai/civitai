import { banReasonDetails } from '~/server/common/constants';
import { BanReasonCode } from '~/server/common/enums';
import { UserMeta } from '~/server/schema/user.schema';
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
      ? banReasonDetails[banDetails.reasonCode].publicBanReasonLabel
      : undefined,
    bannedReasonDetails: banDetails?.detailsExternal,
  });
};
