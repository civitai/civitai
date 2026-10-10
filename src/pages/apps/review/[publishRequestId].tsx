import { Button, Center, Group, Loader, Stack, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import {
  OnsiteReviewModalTitle,
  type AnyRequest,
  type OnsiteReviewMode,
} from '~/components/Apps/OnsiteReviewModal';
import { ReviewDetailView } from '~/components/Apps/ReviewDetailView';
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
 * A flag-gated (`appReviewPage`), deep-linkable, refresh-survivable FULL PAGE for
 * one submission. The queue links here (flag-gated dual-path) instead of
 * `setSelected`; with the flag off the queue keeps opening the modal, so this is
 * fully reversible.
 *
 * 🔴 IT NO LONGER RE-HOSTS `OnsiteReviewModalBody` VERBATIM. Phase 2 landed: the page
 * composes the SAME exported sub-sections into five tabs — Permissions (default) · Code ·
 * Agent report · Manifest · Preview — with the approve/reject bar pinned OUTSIDE them. The
 * panels are shared with the queue modal, so only the arrangement differs; see
 * `ReviewDetailTabsView` and `OnsiteReviewModalBody`'s docstring.
 *
 * 🔴 THE ACTIVE TAB LIVES IN `?tab=`, not in component state, because "deep-linkable,
 * refresh-survivable" is this page's whole reason for existing over the modal. An unknown
 * or absent value resolves to the default rather than rendering an empty panel
 * (`resolveReviewDetailTab`).
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

  const query = trpc.blocks.getPublishRequest.useQuery(
    { publishRequestId },
    { enabled: !!features?.appBlocks && !!features?.appReviewPage, retry: false }
  );

  /**
   * 🔴 MEMOISED ON `query.data`, so the body's one prop is REFERENTIALLY STABLE across a page
   * re-render. `ReviewDetailTabsView` is `memo`-wrapped specifically to keep the view's
   * 60-second relative-time tick from re-rendering every mounted panel (including every open
   * diff table's full row set) — and a `selection` rebuilt on every render would hand that
   * memo a new object each time and buy nothing. The object literal was exactly that.
   *
   * The tick itself lives one level DOWN, in `ReviewDetailView`, so it never re-runs this
   * component; this covers the other re-render sources — a react-query refetch that returns
   * the same data, a flag resolving, a parent update.
   *
   * ⚠️ `useMemo` must sit ABOVE the early return below, or the hook order changes between
   * renders the moment the flags resolve.
   *
   * ⚠️ AND IT RESTS ON `query.data` NEVER BEING REFETCHED. The client sets
   * `staleTime: Infinity` + `refetchOnWindowFocus: false`, this query passes no
   * `refetchInterval`, and NOTHING in the repo invalidates `blocks.getPublishRequest` — so it
   * fetches once per mount and the identity never moves. 🔴 Add a `refetchInterval` or an
   * `invalidate()` and this silently becomes a no-op: react-query's structural sharing cannot
   * save it, because `replaceEqualDeep` returns a revived `Date` verbatim rather than reusing
   * the old reference, and this payload carries `submittedAt`/`reviewedAt` through superjson.
   * One changed nested reference is enough to rebuild the whole object.
   */
  const selection = useMemo(
    () =>
      query.data != null
        ? {
            request: query.data.request as unknown as AnyRequest,
            mode: query.data.mode as OnsiteReviewMode,
          }
        : null,
    [query.data]
  );

  // Belt-and-suspenders client gate (the SSR resolver already fail-closed).
  if (!features?.appBlocks || !features?.appReviewPage) return <NotFound />;

  return (
    <>
      <Meta title="App submission review — Civitai" deIndex />
      {/*
        🔴 NO `title` / `actions` ON THE LAYOUT, AND THAT IS WHAT PUTS THE BACK CONTROL TOP
        LEFT. `AppsPageLayout` renders its header band as
        `<Group justify="space-between">{title}{actions}</Group>`, so anything handed to
        `actions` is RIGHT-aligned BY CONSTRUCTION — the "Review queue" button could not be
        moved left from the calling side. The alternative was a new leading-slot prop on the
        layout; that file is shared chrome for twelve routes (with a per-pixel alignment
        ledger) and is being edited concurrently, so this page owns its own header block
        instead. Nothing about `AppsPageLayout` changes.

        The back control is rendered ABOVE the conditional content on purpose: it must be
        reachable while the fetch is in flight and on the fail-closed NotFound branch, which
        is exactly when a mod most wants out.
      */}
      <AppsPageLayout>
        <Stack gap="md">
          <Stack gap={4}>
            <Group>
              <Button
                component={Link}
                href="/apps/review"
                variant="default"
                size="xs"
                leftSection={<IconArrowLeft size={14} />}
                data-testid="apps-review-back-to-queue"
              >
                Review queue
              </Button>
            </Group>
            <Title order={2}>
              {selection ? <OnsiteReviewModalTitle selection={selection} /> : 'Submission review'}
            </Title>
          </Stack>

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
            <ReviewDetailView
              // Route param remounts per submission (fresh approve/reject state);
              // key parity with the modal for defensiveness.
              key={selection.request.id}
              selection={selection}
              // Q6: after approve/reject, redirect to the queue (matches today's
              // modal-close-then-invalidate — the mutation already invalidates the
              // list queries, so the queue is fresh on arrival).
              onClose={() => void router.push('/apps/review')}
            />
          )}
        </Stack>
      </AppsPageLayout>
    </>
  );
}
