import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

export type ReferralDashboardData = inferRouterOutputs<AppRouter>['referral']['getDashboard'];

export type ReferralDashboardVariantProps = {
  data: ReferralDashboardData;
  shareLink: string;
  onRedeem: (offerIndex: number) => void;
  isRedeeming: boolean;
  pendingOffer: number | null;
  onOpenShop: () => void;
};
