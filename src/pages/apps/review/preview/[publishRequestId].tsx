import { Alert, Box, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowLeft, IconWindow, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import type { AnyRequest, OnsiteReviewMode } from '~/components/Apps/OnsiteReviewModal';
import { ReviewActionBar } from '~/components/Apps/ReviewActionBar';
import { AllCaughtUp } from '~/components/Apps/ReviewDetailView';
import { ReviewBlockPreviewHost } from '~/components/Apps/ReviewBlockPreviewHost';
import { useNextPendingReview } from '~/components/Apps/useNextPendingReview';
import { trpc } from '~/utils/trpc';
import { useReviewPreview } from '~/components/Apps/useReviewPreview';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * MOD REVIEW SANDBOX (#2831) — full-page review preview
 * (`/apps/review/preview/<publishRequestId>`).
 *
 * The review modal's inline preview mounts the block in a squished 420px iframe.
 * This page mounts the SAME review host bridge (`ReviewBlockPreviewHost`) at FULL
 * VIEWPORT so a mod can review the pending app "as the user would see it", and —
 * because it's its own tab — keep the review modal open alongside it.
 *
 * It replaces the old modal "Open review host" button, which linked to the raw
 * `<host>/<slug>?mr=<token>` URL: opened top-level that URL has no host bridge, so
 * the SDK block hangs on "Connecting to host" (the bug #3172 fixed for the iframe).
 * This route is same-origin and mounts the real bridge, so the block renders.
 *
 * GATE: mirrors `/apps/review` exactly — `features.appBlocks` required (else 404),
 * login required (else redirect), moderator required via `isAppReviewer` (else
 * 404). Fail-closed for non-moderators and when the flag is off. The `slug` is
 * resolved server-side (the shared `getReviewStatus` shape omits it, kept minimal
 * for the modal path); a missing / non-pending request 404s.
 */

interface ReviewPreviewPageProps {
  publishRequestId: string;
  slug: string;
}

export const getServerSideProps = createServerSideProps<ReviewPreviewPageProps>({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
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

    // Resolve the slug for the host bridge server-side. Missing / non-pending
    // request → the same fail-closed 404 (never leaks which).
    const { resolveReviewPreviewTarget } = await import(
      '~/server/services/blocks/publish-request.service'
    );
    const target = await resolveReviewPreviewTarget(publishRequestId);
    if (!target) return { notFound: true };

    return { props: { publishRequestId: target.id, slug: target.slug } };
  },
});

export default function ReviewPreviewPage({ publishRequestId, slug }: ReviewPreviewPageProps) {
  const features = useFeatureFlags();
  const { detail, isLive, inProgress, isFailed, stableIframeSrc, error } =
    useReviewPreview(publishRequestId);

  /*
    The DECISION BAR, so a moderator who opened the app full-page can approve or reject it
    from here. Only with the per-submission review page (`appReviewPage`): that is where
    "Back to review" leads and where "next" opens. The request is the same payload the review
    page reads.
  */
  const reviewPage = !!features?.appBlocks && !!features?.appReviewPage;
  const requestQuery = trpc.blocks.getPublishRequest.useQuery(
    { publishRequestId },
    { enabled: reviewPage, retry: false }
  );
  const selection = useMemo(
    () =>
      requestQuery.data != null
        ? {
            request: requestQuery.data.request as unknown as AnyRequest,
            mode: requestQuery.data.mode as OnsiteReviewMode,
          }
        : null,
    [requestQuery.data]
  );
  const { openNext, caughtUp } = useNextPendingReview(publishRequestId);
  const backHref = reviewPage ? `/apps/review/${publishRequestId}` : '/apps/review';

  // Belt-and-suspenders client gate (the SSR resolver already fail-closed).
  if (!features?.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title={`Review preview — ${slug}`} deIndex />
      {/* Fill the viewport under the global header so the mod reviews the app
          full-size (the modal uses a fixed 420px panel).

          🔴 A FLEX COLUMN, for the same reason as the modal's panel:
          `ReviewBlockPreviewHost` passes `fit="fill"`, so this box is what the
          host resolves its height against. Before, the host claimed
          `100dvh − header` for ITSELF while the run-for-real banner still had to
          fit above it inside a box of exactly that height, so the content
          overflowed by the banner's height and the page scrolled beside the
          block's own scrollbar. Bounding here and letting the host take the
          remainder removes the arithmetic instead of re-tuning it. */}
      <Box
        style={{
          height: 'calc(100dvh - var(--header-height))',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* "Back to review" in EVERY state, the live one included — before, the live
            preview filled the viewport with no way back but the browser's own. */}
        <Group justify="space-between" px="md" py={6} wrap="nowrap">
          <Button
            component={Link}
            href={backHref}
            variant="default"
            size="xs"
            leftSection={<IconArrowLeft size={14} />}
            data-testid="apps-review-preview-back"
          >
            {reviewPage ? 'Back to review' : 'Back to review queue'}
          </Button>
          <Text size="xs" c="dimmed" truncate>
            Review preview — {slug}
          </Text>
        </Group>
        {caughtUp ? (
          <Box p="xl" style={{ flex: 1 }}>
            <AllCaughtUp />
          </Box>
        ) : isLive && stableIframeSrc ? (
          <ReviewBlockPreviewHost
            publishRequestId={publishRequestId}
            slug={slug}
            iframeSrc={stableIframeSrc}
          />
        ) : (
          <NonLiveState
            slug={slug}
            inProgress={inProgress}
            isFailed={isFailed}
            failureDetail={detail?.error}
            buildingSha={detail?.sha}
            errorMessage={error?.message}
          />
        )}
        {selection && !caughtUp && (
          <Box
            px="md"
            pt="xs"
            pb="xs"
            style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
          >
            <ReviewActionBar
              key={`actions-${selection.request.id}`}
              selection={selection}
              onClose={openNext}
              approveAndNext
            />
          </Box>
        )}
      </Box>
    </>
  );
}

/**
 * Centered status surface for every non-live preview state. `none` (no preview
 * started) points the mod back to the queue; building/deploying shows progress;
 * failed shows the error. Only `preview-live` mounts the host (handled above).
 */
function NonLiveState({
  slug,
  inProgress,
  isFailed,
  failureDetail,
  buildingSha,
  errorMessage,
}: {
  slug: string;
  inProgress: boolean;
  isFailed: boolean;
  failureDetail?: string;
  buildingSha?: string;
  errorMessage?: string;
}) {
  return (
    <Stack align="center" justify="center" gap="md" p="xl" style={{ height: '100%' }}>
      <Group gap={6}>
        <IconWindow size={18} />
        <Text fw={600}>Review preview — {slug}</Text>
      </Group>

      {inProgress ? (
        <Stack align="center" gap={6}>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Building preview…
            {buildingSha ? ` (sha ${buildingSha.slice(0, 12)})` : ''}
          </Text>
        </Stack>
      ) : isFailed ? (
        <Alert color="red" variant="light" icon={<IconX size={16} />} maw={520}>
          {failureDetail ?? 'Review preview failed.'}
        </Alert>
      ) : (
        <Text size="sm" c="dimmed" ta="center" maw={520}>
          No active review preview — start one from the review queue.
        </Text>
      )}

      {errorMessage && (
        <Text size="xs" c="dimmed" ta="center" maw={520}>
          {errorMessage}
        </Text>
      )}

      <Button
        component={Link}
        href="/apps/review"
        variant="default"
        size="xs"
        leftSection={<IconArrowLeft size={14} />}
      >
        Back to review queue
      </Button>
    </Stack>
  );
}
