import { Button, Center, Loader } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import {
  OnsiteReviewModalBody,
  OnsiteReviewModalTitle,
  type AnyRequest,
  type OnsiteReviewMode,
} from '~/components/Apps/OnsiteReviewModal';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

/**
 * PER-SUBMISSION REVIEW PAGE — `/apps/review/<publishRequestId>` (Phase 1 of the
 * App Blocks review modal → page migration).
 *
 * A flag-gated (`appReviewPage`), deep-linkable, refresh-survivable FULL PAGE
 * that RE-HOSTS the exact same on-site review body the `/apps/review` queue opens
 * in a modal today — `OnsiteReviewModalBody`, rendered WITHOUT the `<Modal>`
 * shell. The queue links here (flag-gated dual-path) instead of `setSelected`;
 * with the flag off the queue keeps opening the modal, so this is fully
 * reversible. The report/tabs redesign is intentionally deferred to Phase 2 — the
 * report renders via the existing `AgentReviewPanel`/`ReportBody` as-is.
 *
 * GATE: mirrors `/apps/review` + `/apps/review/preview/<id>` — `features.appBlocks`
 * required (else 404), PLUS `features.appReviewPage` (else 404, so the page is
 * dark unless the flag resolves for the caller), login required (else redirect),
 * moderator required via `isAppReviewer` (else 404). The id is resolved
 * server-side (existence + reviewable status) so a missing / withdrawn request
 * 404s and never leaks which. Fail-closed at every stage.
 *
 * The full request payload (manifest/diff/reviewer blobs, Dates) is fetched
 * CLIENT-SIDE via `blocks.getPublishRequest` — kept off the SSR props so the big
 * blobs don't inflate the HTML and Dates ride the tRPC/superjson path rather than
 * being hand-serialized. The SSR resolver only carries the validated id.
 */

interface ReviewDetailPageProps {
  publishRequestId: string;
}

export const getServerSideProps = createServerSideProps<ReviewDetailPageProps>({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    // The page flag: dark unless it resolves for the caller. `['mod']` static
    // fallback → mods pass on merge, non-mods fail closed even if they somehow
    // reached here (belt with the isAppReviewer gate below).
    if (!features?.appReviewPage) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppReviewer(session.user)) {
      return { notFound: true };
    }

    const rawId = ctx.params?.publishRequestId;
    const publishRequestId =
      typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : '';
    if (!publishRequestId) return { notFound: true };

    // Fail-closed on a missing / withdrawn / superseded request (mirrors the
    // preview route's `resolveReviewPreviewTarget`, but valid for
    // pending/approved/rejected — the page shows history too).
    const { resolveReviewRequestTarget } = await import(
      '~/server/services/blocks/publish-request.service'
    );
    const target = await resolveReviewRequestTarget(publishRequestId);
    if (!target) return { notFound: true };

    return { props: { publishRequestId: target.id } };
  },
});

export default function ReviewDetailPage({ publishRequestId }: ReviewDetailPageProps) {
  const features = useFeatureFlags();
  const router = useRouter();
  // The page has no `<Modal>` shell, so `busyRef` (which the shell used to refuse
  // an in-flight close) has no consumer here — a plain ref satisfies the body's
  // contract. A route-leave busy-guard is a Phase 2 concern; Phase 1 keeps the
  // body behaviour-identical.
  const busyRef = useRef(false);

  const query = trpc.blocks.getPublishRequest.useQuery(
    { publishRequestId },
    { enabled: !!features?.appBlocks && !!features?.appReviewPage, retry: false }
  );

  // Belt-and-suspenders client gate (the SSR resolver already fail-closed).
  if (!features?.appBlocks || !features?.appReviewPage) return <NotFound />;

  const selection =
    query.data != null
      ? {
          request: query.data.request as unknown as AnyRequest,
          mode: query.data.mode as OnsiteReviewMode,
        }
      : null;

  return (
    <>
      <Meta title="App submission review — Civitai" deIndex />
      <AppsPageLayout
        size="xl"
        title={selection ? <OnsiteReviewModalTitle selection={selection} /> : 'Submission review'}
        actions={
          <Button
            component={Link}
            href="/apps/review"
            variant="default"
            size="xs"
            leftSection={<IconArrowLeft size={14} />}
          >
            Review queue
          </Button>
        }
      >
        {query.isLoading ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : query.isError || !selection ? (
          // A NOT_FOUND from the proc (deleted between SSR resolve and fetch) or
          // any other error fails closed to the same not-found surface the SSR
          // gate uses — never a half-rendered review.
          <NotFound />
        ) : (
          <OnsiteReviewModalBody
            // Route param remounts the page per submission (fresh approve/reject
            // state); key parity with the modal for defensiveness.
            key={selection.request.id}
            selection={selection}
            // Q6: after approve/reject, redirect to the queue (matches today's
            // modal-close-then-invalidate — the mutation already invalidates the
            // list queries, so the queue is fresh on arrival).
            onClose={() => void router.push('/apps/review')}
            busyRef={busyRef}
          />
        )}
      </AppsPageLayout>
    </>
  );
}
