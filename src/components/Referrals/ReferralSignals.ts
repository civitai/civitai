import { useCallback } from 'react';
import { showSuccessNotification } from '~/utils/notifications';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { queryClient, trpc } from '~/utils/trpc';
import { getQueryKey } from '@trpc/react-query';

type ReferralPurchasePendingPayload = {
  rewardId: number;
  type: 'membership' | 'buzz';
  tier?: string;
  tokens?: number;
  blueBuzz?: number;
  settlesAt: string;
};

type ReferralSettledPayload = {
  rewardId: number;
  type: 'membership' | 'buzz';
  tokens?: number;
  blueBuzz?: number;
};

type ReferralMilestonePayload = { threshold: number; bonusAmount: number };

type ReferralTierGrantedPayload = {
  redemptionId: number;
  tier: string;
  durationDays: number;
};

function invalidateReferralDashboard() {
  const key = getQueryKey(trpc.referral.getDashboard);
  queryClient.invalidateQueries({ queryKey: key });
}

export const useReferralSignals = () => {
  useSignalConnection(
    SignalMessages.ReferralPurchasePending,
    useCallback((data: ReferralPurchasePendingPayload) => {
      invalidateReferralDashboard();
      const label =
        data.type === 'membership'
          ? `${data.tokens ?? 0} token${(data.tokens ?? 0) === 1 ? '' : 's'} pending`
          : `${data.blueBuzz ?? 0} Blue Buzz pending`;
      showSuccessNotification({ title: 'New referral activity', message: label });
    }, [])
  );

  useSignalConnection(
    SignalMessages.ReferralSettled,
    useCallback((data: ReferralSettledPayload) => {
      invalidateReferralDashboard();
      const label = data.tokens
        ? `${data.tokens} token${data.tokens === 1 ? '' : 's'} settled`
        : `${data.blueBuzz ?? 0} Blue Buzz settled`;
      showSuccessNotification({ title: 'Referral reward settled', message: label });
    }, [])
  );

  useSignalConnection(
    SignalMessages.ReferralMilestone,
    useCallback((data: ReferralMilestonePayload) => {
      invalidateReferralDashboard();
      showSuccessNotification({
        title: `Milestone reached (${data.threshold.toLocaleString()} Blue Buzz)`,
        message: `+${data.bonusAmount.toLocaleString()} bonus Blue Buzz`,
      });
    }, [])
  );

  useSignalConnection(
    SignalMessages.ReferralTierGranted,
    useCallback((data: ReferralTierGrantedPayload) => {
      invalidateReferralDashboard();
      showSuccessNotification({
        title: 'Tokens redeemed',
        message: `${data.durationDays} days of ${data.tier} unlocked`,
      });
    }, [])
  );

  useSignalConnection(
    SignalMessages.ReferralClawback,
    useCallback(() => {
      invalidateReferralDashboard();
    }, [])
  );

  useSignalConnection(
    SignalMessages.ReferralTokenExpiringSoon,
    useCallback(() => {
      invalidateReferralDashboard();
    }, [])
  );
};
