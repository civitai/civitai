import { SessionUser } from 'next-auth';

export function getUserBuzzBonusAmount(user: SessionUser) {
  if (user.tier) return 5000;

  return 100;
}
