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
  { key: 'recruit', name: 'Recruit', min: 1_000 },
  { key: 'advocate', name: 'Advocate', min: 10_000 },
  { key: 'champion', name: 'Champion', min: 50_000 },
  { key: 'legend', name: 'Legend', min: 200_000 },
];

export const MILESTONE_NAMES: Record<number, string> = {
  1_000: 'Rookie',
  10_000: 'Recruit',
  50_000: 'Advocate',
  200_000: 'Champion',
  1_000_000: 'Legend',
};

/**
 * Recruiter Score is the same metric as lifetime Referral Points —
 * 1 point per Blue Buzz earned + tier-weighted points per paid referral
 * month (1k/2.5k/5k for Bronze/Silver/Gold, ≈10% of each tier's monthly
 * Buzz value). Keep this helper as a stable alias for UI code.
 */
export function computeRecruiterScore(lifetimePoints: number) {
  return lifetimePoints;
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
