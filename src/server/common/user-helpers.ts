import { SessionUser } from 'next-auth';
import { constants } from './constants';

export function getUserBuzzBonusAmount(user: SessionUser) {
  if (user.tier) return 5000;
  if (!!user.createdAt && !checkUserCreatedAfterBuzzLaunch(user)) return 500;

  return 100;
}

export function checkUserCreatedAfterBuzzLaunch(user: SessionUser) {
  return !!user.createdAt && new Date(user.createdAt) > constants.buzz.cutoffDate;
}
