import { Container, Stack, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { EarningsHeader } from '~/components/CreatorEarnings/EarningsHeader';
import { PerModelTable } from '~/components/CreatorEarnings/PerModelTable';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    return { props: {} };
  },
});

export default function CreatorEarningsDashboard() {
  return (
    <>
      <Meta title="Civitai | Creator Earnings Dashboard" deIndex />
      <Container size="lg">
        <Stack gap="md">
          <Title order={1}>Creator Earnings Dashboard</Title>
          <EarningsHeader />
          <PerModelTable />
        </Stack>
      </Container>
    </>
  );
}
