import { Alert, Button, Card, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { deployRefetchInterval } from '~/components/Apps/deploy-status';
import { MySubmissionsList, type Submission } from '~/components/Apps/MySubmissionsList';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/my-submissions — dev's view of their publish-request history.
 *
 * Lists every request submitted by the viewer, newest first. For pending
 * requests there's a Withdraw button. Reviewer notes (approval notes /
 * rejection reason) open in a modal from a "See reviewer notes" button below
 * the status badge. Approved apps surface a compact runs/users (30d) stat and
 * an Analytics modal, plus a CLI-first authoring affordance.
 *
 * v0 gate: requires `isAppDeveloper` (mods at v0; v1 opens to external
 * developers behind W11/W5).
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    // Author-capability gate (Phase B): the dedicated `appBlocksAuthor` flag
    // (Flipt `app-blocks-author`, static fallback mod-only), INDEPENDENT of the
    // marketplace-visibility `appBlocks` flag (which widens to public at GA).
    if (!features?.appBlocksAuthor) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppDeveloper(session.user, { appBlocksAuthor: features?.appBlocksAuthor })) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

export default function MySubmissionsPage() {
  const features = useFeatureFlags();
  const submissionsQuery = trpc.blocks.listMyPublishRequests.useQuery(undefined, {
    enabled: !!features?.appBlocks,
    // Poll while an approved submission is building/deploying so the badge
    // live-updates; back off / stop once nothing is in flight.
    refetchInterval: (query) => deployRefetchInterval((query.state.data ?? []) as Submission[]),
  });

  const withdrawMutation = trpc.blocks.withdrawPublishRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      await submissionsQuery.refetch();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Withdraw failed',
        error: new Error(e.message),
      });
    },
  });

  if (!features?.appBlocks) return <NotFound />;

  const submissions = (submissionsQuery.data ?? []) as Submission[];

  return (
    <>
      <Meta title="My app submissions — Civitai" deIndex />
      <AppsPageLayout
        title="My submissions"
        subtitle="Status of every app submission you've made. Open a row's reviewer notes to see mod feedback; pending submissions can be withdrawn."
        actions={
          <Button
            component={Link}
            href="/apps/submit"
            rightSection={<IconArrowRight size={16} />}
          >
            Submit a new app
          </Button>
        }
      >
        {submissionsQuery.isError && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {submissionsQuery.error.message}
          </Alert>
        )}

        {!submissionsQuery.isLoading && submissions.length === 0 && (
          <Card withBorder p="lg">
            <Stack gap="xs" align="center" py="md">
              <Text>You haven't submitted any apps yet.</Text>
              <Button component={Link} href="/apps/submit">
                Submit your first app
              </Button>
            </Stack>
          </Card>
        )}

        {submissions.length > 0 && (
          <MySubmissionsList
            submissions={submissions}
            onWithdraw={(id) => withdrawMutation.mutate({ publishRequestId: id })}
            withdrawing={withdrawMutation.isPending}
          />
        )}
      </AppsPageLayout>
    </>
  );
}
