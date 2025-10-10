import { buzzConstants } from '~/shared/constants/buzz.constants';

type Props = {
  tier?: string;
  createdAt?: Date;
};

export function getUserBuzzBonusAmount(user: Props) {
  if (user.tier) return 5000;
  if (!!user.createdAt && !checkUserCreatedAfterBuzzLaunch(user)) return 500;

  return 100;
}

export function checkUserCreatedAfterBuzzLaunch(user: Props) {
  return !!user.createdAt && new Date(user.createdAt) > buzzConstants.cutoffDate;
}
