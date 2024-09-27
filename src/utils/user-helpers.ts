import dayjs from 'dayjs';
import { banReasonDetails } from '~/server/common/constants';
import { UserMeta } from '~/server/schema/user.schema';

export const getUserBanDetails = ({
  meta,
  isModerator,
}: {
  meta?: UserMeta;
  isModerator?: boolean;
}) => {
  if (!meta) return {};

  const { banDetails } = meta;

  return {
    banReasonCode: isModerator ? banDetails?.reasonCode : undefined,
    banReason: banDetails?.reasonCode
      ? banReasonDetails[banDetails.reasonCode].publicBanReasonLabel
      : undefined,
    bannedReasonDetails: banDetails?.detailsExternal,
  };
};
