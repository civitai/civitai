import { Alert, Box, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowLeft, IconWindow, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ReviewBlockPreviewHost } from '~/components/Apps/ReviewBlockPreviewHost';
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

  // Belt-and-suspenders client gate (the SSR resolver already fail-closed).
  if (!features?.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title={`Review preview — ${slug}`} deIndex />
      {/* Fill the viewport under the global 60px header so the mod reviews the
          app full-size (the modal used a fixed 420px iframe). */}
      <Box style={{ height: 'calc(100dvh - var(--header-height))', width: '100%' }}>
        {isLive && stableIframeSrc ? (
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
