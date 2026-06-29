import { Container } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * PUBLIC "App builders" get-started landing page — Scope A soft launch.
 *
 * Gating (deliberately DIFFERENT from every other `/apps/*` page): this page is
 * PUBLIC and gates ONLY on the dedicated `appBlocksGetStarted` flag. It does NOT
 * call `resolveAppsPageAccess` and does NOT gate on the mod-only `appBlocks`
 * flag — that flag (and `resolveAppsPageAccess`) keep guarding all the other
 * `/apps/*` surfaces (marketplace, submit, installed, review, …) exactly as
 * before. This page is purely additive; nothing else's gating changes.
 *
 * `appBlocksGetStarted` is public/everyone by default; its Flipt key is a kill
 * switch — flip it off to drop this page + its nav entry without a deploy.
 *
 * deIndexed for now (private-beta funnel; not ready for organic search).
 * TODO(launch): drop `deIndex` to make indexable when comms is ready.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.appBlocksGetStarted) return { notFound: true };
    return { props: {} };
  },
});

export default function AppsGetStartedPage() {
  const features = useFeatureFlags();

  // Belt-and-suspenders: the SSR resolver already 404s when the flag is off, but
  // guard client-side too (mirrors /apps/index.tsx) so a stale client render
  // can't flash the page.
  if (!features.appBlocksGetStarted) return <NotFound />;

  return (
    <>
      {/* deIndexed initially — private-beta funnel, not for organic search yet.
          TODO(launch): drop `deIndex` to make indexable when comms is ready. */}
      <Meta
        title="Build apps on Civitai"
        description="Build small web apps that run inside Civitai. Install the Civitai CLI and runtime SDK, scaffold an app, and test it locally. Publishing is in private beta."
        deIndex
      />
      <Container size="md" py="xl">
        <GetStartedBody />
      </Container>
    </>
  );
}
