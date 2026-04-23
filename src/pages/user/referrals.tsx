import { Container, Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { ReferralDashboard } from '~/components/Referrals/ReferralDashboard';
import { ReferralDashboardLite } from '~/components/Referrals/ReferralDashboardLite';
import { ReferralDashboardSkeleton } from '~/components/Referrals/ReferralDashboardSkeleton';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.referralProgramV2) {
      return { notFound: true };
    }
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

export default function ReferralsPage() {
  const router = useRouter();
  const useLite = router.query.lite === '1';
  const Dashboard = useLite ? ReferralDashboardLite : ReferralDashboard;
  const { data, isLoading, refetch } = trpc.referral.getDashboard.useQuery();
  const [pendingOffer, setPendingOffer] = useState<number | null>(null);

  const redeemMutation = trpc.referral.redeem.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Redeemed', message: 'Membership perks unlocked' });
      refetch();
      setPendingOffer(null);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Redemption failed', error: new Error(e.message) });
      setPendingOffer(null);
    },
  });

  const shareLink = useMemo(() => {
    if (!data) return '';
    return typeof window !== 'undefined'
      ? `${window.location.origin}/?ref_code=${data.code}`
      : `/?ref_code=${data.code}`;
  }, [data]);

  if (isLoading || !data) {
    return (
      <>
        <Meta title="Civitai | Refer & earn" deIndex />
        <Container size="md" className="py-8">
          <ReferralDashboardSkeleton />
        </Container>
      </>
    );
  }

  const onRedeem = (offerIndex: number) => {
    setPendingOffer(offerIndex);
    redeemMutation.mutate({ offerIndex });
  };

  return (
    <>
      <Meta title="Civitai | Refer & earn" deIndex />
      <Container size="md" className="py-8">
        <Stack gap="lg">
          <Dashboard
            data={data}
            shareLink={shareLink}
            onRedeem={onRedeem}
            isRedeeming={redeemMutation.isLoading}
            pendingOffer={pendingOffer}
          />
        </Stack>
      </Container>
    </>
  );
}
