import { Alert, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { deployRefetchInterval } from '~/components/Apps/deploy-status';
import { MySubmissionsList, type Submission } from '~/components/Apps/MySubmissionsList';
import {
  OffsiteSubmissionsList,
  type OffsiteSubmission,
} from '~/components/Apps/OffsiteSubmissionsList';
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

  // OFF-SITE (external-link) submissions (W13 P3a) — listed alongside the on-site
  // publish requests. Dark behind `app-blocks-author` at the proc; enabled here on
  // the same `appBlocks` gate as the on-site list.
  const offsiteQuery = trpc.appListings.listMySubmissions.useQuery(
    { limit: 100 },
    { enabled: !!features?.appBlocks }
  );
  const offsiteWithdrawMutation = trpc.appListings.withdrawExternalRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'External submission withdrawn.' });
      await offsiteQuery.refetch();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Withdraw failed', error: new Error(e.message) });
    },
  });

  if (!features?.appBlocks) return <NotFound />;

  const submissions = (submissionsQuery.data ?? []) as Submission[];
  const offsiteSubmissions = (offsiteQuery.data?.items ?? []) as OffsiteSubmission[];

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

        {offsiteQuery.isError && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {offsiteQuery.error.message}
          </Alert>
        )}

        {!submissionsQuery.isLoading &&
          !offsiteQuery.isLoading &&
          submissions.length === 0 &&
          offsiteSubmissions.length === 0 && (
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
            canOpenPage={!!features?.appBlocksPages}
          />
        )}

        {offsiteSubmissions.length > 0 && (
          <Stack gap="xs" mt={submissions.length > 0 ? 'lg' : undefined}>
            <Group gap={6}>
              <IconExternalLink size={16} />
              <Title order={5}>External-link submissions</Title>
            </Group>
            <OffsiteSubmissionsList
              submissions={offsiteSubmissions}
              onWithdraw={(id) => offsiteWithdrawMutation.mutate({ publishRequestId: id })}
              withdrawing={offsiteWithdrawMutation.isPending}
            />
          </Stack>
        )}
      </AppsPageLayout>
    </>
  );
}
