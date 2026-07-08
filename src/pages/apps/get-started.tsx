import { Container } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import { resolveGetStartedAccess } from '~/components/Apps/resolveGetStartedAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * "App builders" get-started landing page — Scope A soft launch.
 *
 * Gating (deliberately DIFFERENT from every other `/apps/*` page): this page
 * gates ONLY on the dedicated `appBlocksGetStarted` flag. It does NOT call
 * `resolveAppsPageAccess` and does NOT gate on the mod-only `appBlocks` flag —
 * that flag (and `resolveAppsPageAccess`) keep guarding all the other `/apps/*`
 * surfaces (marketplace, submit, installed, review, …) exactly as before. This
 * page is purely additive; nothing else's gating changes.
 *
 * `appBlocksGetStarted` is STAGED MOD-ONLY today (`['mod']`, like `appBlocks` /
 * `appBlocksPages`) so it deploys dark-to-public: it resolves for moderators
 * only, who can review the page + its nav entry live on prod. It's widened to
 * `['public']` (a one-line flag change in feature-flags.service.ts) when launch
 * copy + the real Request-access link land. The Flipt key stays the kill-switch
 * / future-widen lever — flip it off to drop this page + its nav entry without a
 * deploy. The runtime gate below is on `appBlocksGetStarted` REGARDLESS of the
 * flag's availability value, so widening to public needs no page change.
 *
 * deIndexed for now (private-beta funnel; not ready for organic search).
 * TODO(launch): drop `deIndex` to make indexable when comms is ready.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) =>
    resolveGetStartedAccess({ features: { appBlocksGetStarted: features?.appBlocksGetStarted } }),
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
        title="Build on Civitai"
        description="Build small web apps that run inside Civitai. Install the Civitai CLI and runtime SDK, scaffold an app, and test it locally."
        deIndex
      />
      <Container size="md" py="xl">
        <GetStartedBody />
      </Container>
    </>
  );
}
