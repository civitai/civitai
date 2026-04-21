import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type ReferralDashboardData = inferRouterOutputs<AppRouter>['referral']['getDashboard'];

export type ReferralDashboardProps = {
  data: ReferralDashboardData;
  shareLink: string;
  onRedeem: (offerIndex: number) => void;
  isRedeeming: boolean;
  pendingOffer: number | null;
};

export type RecruiterRank = {
  key: 'rookie' | 'recruit' | 'advocate' | 'champion' | 'legend';
  name: string;
  min: number;
};

export const RECRUITER_RANKS: RecruiterRank[] = [
  { key: 'rookie', name: 'Rookie', min: 0 },
  { key: 'recruit', name: 'Recruit', min: 1 },
  { key: 'advocate', name: 'Advocate', min: 10 },
  { key: 'champion', name: 'Champion', min: 50 },
  { key: 'legend', name: 'Legend', min: 200 },
];

export const MILESTONE_NAMES: Record<number, string> = {
  1_000: 'Rookie',
  10_000: 'Recruit',
  50_000: 'Advocate',
  200_000: 'Champion',
  1_000_000: 'Legend',
};

export function computeRecruiterScore(conversions: number, lifetimeBlueBuzz: number) {
  return conversions + Math.floor(lifetimeBlueBuzz / 1_000);
}

export function getRankForScore(score: number): {
  current: RecruiterRank;
  next: RecruiterRank | null;
} {
  let current = RECRUITER_RANKS[0];
  let next: RecruiterRank | null = null;
  for (const rank of RECRUITER_RANKS) {
    if (score >= rank.min) current = rank;
    else {
      next = rank;
      break;
    }
  }
  return { current, next };
}
