import { Anchor, Badge, Center, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import Link from 'next/link';

import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_MEASURES } from '~/components/Apps/appsPageWidths';
import { historyStatusColor } from '~/components/Apps/myAppsView';
import { ReviewerByline, type DecisionReviewerView } from '~/components/Apps/ReviewerByline';
import { ReviewThread } from '~/components/Apps/ReviewThread';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { MY_APPS_HREF } from '~/shared/constants/apps-build.constants';
import { parseReviewSubjectId } from '~/shared/utils/app-review-thread';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

/**
 * `/apps/submissions/<publishRequestId>` — the conversation on one review decision, as its
 * developer side sees it: the submission, the decision and who made it, and the reply thread
 * with Civitai App Review. The `app-review-reply-to-developer` notification links here.
 *
 * GATE: `features.appBlocks` and `features.appReviewReplies` (else 404), login (else redirect),
 * a request-shaped id (else 404). Whether the viewer is a participant (the submitter, the
 * listing's owner, or a moderator) is decided by the procedures, which answer NOT_FOUND for
 * anyone else; the page then renders the same not-found surface.
 */

type SubmissionThreadPageProps = { subjectId: string };

export const getServerSideProps = createServerSideProps<SubmissionThreadPageProps>({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks || !features?.appReviewReplies) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    }
    const rawId = ctx.params?.subjectId;
    const subjectId = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : '';
    if (!parseReviewSubjectId(subjectId)) return { notFound: true };
    return { props: { subjectId } };
  },
});

export default function SubmissionThreadPage({ subjectId }: SubmissionThreadPageProps) {
  const features = useFeatureFlags();
  const enabled = !!features?.appBlocks && !!features?.appReviewReplies;
  const query = trpc.appListings.getReviewThreadSubject.useQuery(
    { subjectId },
    { enabled, retry: false }
  );

  if (!enabled) return <NotFound />;
  if (query.isError) return <NotFound />;

  const subject = query.data;
  return (
    <>
      <Meta title="Submission conversation — Civitai Apps" deIndex />
      <AppsPageLayout
        measure={APPS_PAGE_MEASURES['/apps/submissions/[subjectId]']}
        title="Submission conversation"
        subtitle={
          <Anchor component={Link} href={MY_APPS_HREF} size="sm">
            Back to My builds
          </Anchor>
        }
      >
        {!subject ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : (
          <Stack gap="md">
            <Paper withBorder p="md" radius="md" data-testid="submission-thread-subject">
              <Stack gap={6}>
                <Group gap="xs" wrap="wrap">
                  <Title order={3}>{subject.name}</Title>
                  <Badge
                    size="sm"
                    variant="light"
                    color={subject.kind === 'version' ? 'blue' : 'grape'}
                  >
                    {subject.kind === 'version' ? `v${subject.version ?? '?'}` : 'Listing edit'}
                  </Badge>
                  <Badge size="sm" variant="outline" color={historyStatusColor(subject.status)}>
                    {subject.status}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {subject.slug}
                </Text>
                {subject.rejectionReason ? (
                  <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                    {subject.rejectionReason}
                  </Text>
                ) : subject.approvalNotes ? (
                  <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                    {subject.approvalNotes}
                  </Text>
                ) : null}
                <ReviewerByline
                  reviewer={subject.reviewer as DecisionReviewerView | null}
                  testId="submission-thread-reviewer"
                />
              </Stack>
            </Paper>
            <ReviewThread subjectId={subjectId} />
          </Stack>
        )}
      </AppsPageLayout>
    </>
  );
}
