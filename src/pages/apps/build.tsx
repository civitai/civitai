import { Button } from '@mantine/core';
import { IconLayoutList, IconSparkles } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { Page } from '~/components/AppLayout/Page';
import { AppAssistantWorkspace } from '~/components/Apps/AppAssistant/AppAssistantWorkspace';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppsBuildBody } from '~/components/Apps/AppsBuildBody';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';

type AssistantProps = {
  mode: 'assistant';
  /** The account may open dev tunnels, which the live preview runs on. */
  canPreview: boolean;
  /** The hosted sandbox service's base URL, or null when this deployment has none. */
  sandboxUrl: string | null;
  /** The assistant may start read-only subagents. */
  subagents: boolean;
  /** Replies run on the server runner (`appAssistantRemoteRunner`, the runner and the sandbox service configured). */
  remoteRunner: boolean;
};
export type AppsBuildPageProps = { mode: 'build' } | AssistantProps;

/** `?view=apps`: an author in the assistant view opens their app list instead. */
export const APPS_BUILD_APPS_VIEW = 'apps';

/**
 * `/apps/build` — the ONE place to build an app. It replaced `/apps/get-started`, `/apps/mine`
 * and `/apps/assistant` (all 301 here) and absorbed the on-platform half of `/apps/submit`.
 *
 *   assistant — the App Assistant workspace, for a signed-in viewer `canAccessAppAssistant`
 *               admits. An author also gets a "My apps" switch to the states below.
 *   A · pitch     (not an author)                   — recruit, and request access
 *   B · first-app (author, nothing yet)             — agent card, manual setup collapsed, create
 *   C · workbench (author, has apps or submissions) — the app list + `New app`
 *
 * 🔴 THE GATE IS `resolveAppsBuildPageMode`, WHICH THE RAIL'S Build ROW ALSO CALLS. That sharing
 * is the point of the consolidation, not an implementation detail: the routes this replaced each
 * wrote their page gate and their tab gate separately, and they disagreed — a store-visible
 * non-author was offered tabs into two 404s (PR #4668, #3899). Do not add a second flag check to
 * this file. See `resolveBuildPageAccess` for the one login redirect and why the build states
 * have none.
 */
export const getServerSideProps = createServerSideProps<AppsBuildPageProps>({
  useSession: true,
  resolver: async ({ features, session }) => {
    const access = resolveBuildPageAccess({ features, user: session?.user });
    if (!('assistant' in access)) return access;

    const user = session!.user!;
    const { isAppBlocksDevTunnelEnabled } = await import('~/server/services/app-blocks-flag');
    const canPreview = !!features?.appBlocksAuthor && (await isAppBlocksDevTunnelEnabled({ user }));

    const { env } = await import('~/env/server');
    const { isAssistantRunnerConfigured } = await import(
      '~/server/services/app-assistant/assistant-runner-tokens'
    );
    // No route CSP: a header CSP persists across the tab's client-side navigations and would block
    // payment and captcha frames on later pages.
    return {
      props: {
        mode: 'assistant',
        canPreview,
        sandboxUrl: env.APP_ASSISTANT_SANDBOX_URL ?? null,
        subagents: !!features?.appAssistantSubagents,
        // The runner refuses to start without its sandbox service; the page needs one too.
        remoteRunner:
          !!features?.appAssistantRemoteRunner &&
          isAssistantRunnerConfigured() &&
          !!env.APP_ASSISTANT_SANDBOX_URL,
      },
    };
  },
});

export default function AppsBuildPage(props: AppsBuildPageProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const router = useRouter();

  /**
   * 🔴 `deIndex` IS PER-STATE, AND IT IS THE AUTHOR TERM THAT DECIDES IT — deliberately
   * NOT the full state machine. State A is a recruiting page and SHOULD be indexable; states B
   * and C render a named viewer's own app list and submission history, and the assistant a
   * viewer's own conversation, so none of those may be. `isAuthor` is SSR-frozen, unlike the
   * client-only `getNavSummary` that splits B from C, so the tag a crawler receives is the tag we
   * meant. (Nothing observable changes today: an anonymous crawler holds no store flag and gets
   * `notFound`.)
   */
  const isAuthor = currentUser
    ? isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })
    : false;

  if (props.mode === 'assistant') {
    // The author's app list has no other route since `/apps/mine` redirects here, so the
    // assistant view must not hide it from them.
    const showApps = isAuthor && router.query.view === APPS_BUILD_APPS_VIEW;
    const switchTo = showApps ? (
      <Button
        component={Link}
        href="/apps/build"
        variant="default"
        leftSection={<IconSparkles size={16} />}
        data-testid="apps-build-show-assistant"
      >
        App Assistant
      </Button>
    ) : isAuthor ? (
      <Button
        component={Link}
        href={`/apps/build?view=${APPS_BUILD_APPS_VIEW}`}
        variant="default"
        leftSection={<IconLayoutList size={16} />}
        data-testid="apps-build-show-apps"
      >
        My apps
      </Button>
    ) : undefined;

    return (
      <>
        <Meta title="Build — Civitai Apps" deIndex />
        <AppsPageLayout
          title="Build"
          subtitle={
            showApps ? undefined : 'Describe an app and the App Assistant builds it with you.'
          }
          actions={switchTo}
        >
          {showApps ? (
            <AppsBuildBody />
          ) : (
            <AppAssistantWorkspace
              canPreview={props.canPreview}
              sandboxUrl={props.sandboxUrl}
              subagents={props.subagents}
              remoteRunner={props.remoteRunner}
            />
          )}
        </AppsPageLayout>
      </>
    );
  }

  return (
    <>
      <Meta
        title="Build on Civitai"
        description="Build small web apps that run inside Civitai — with the App Assistant, or with the Civitai CLI and runtime SDK — and publish them to the app store."
        deIndex={isAuthor}
      />
      {/*
        NO `measure` — `/apps/build` takes the FULL container, and it is listed in
        `APPS_FULL_MEASURE_PAGES` for that reason. Two states need it: the workbench renders
        `MyAppsBody`'s table against a measured `SUBMISSIONS_TABLE_MIN_WIDTH` scroll floor of
        1424px (above `APPS_READABLE_MEASURE`'s 1368 ceiling), and the assistant puts a live
        preview beside the chat. See the note on that list in `~/components/Apps/appsPageWidths`.
      */}
      <AppsPageLayout title="Build">
        <AppsBuildBody />
      </AppsPageLayout>
    </>
  );
}

/**
 * No footer in the assistant view: the workspace fills the viewport, as it did at `/apps/assistant`.
 * Decided from the SSR props, so the server render and the first client paint agree. The default
 * export stays a plain function declaration so the `/apps` layout guards can parse it.
 */
Page(AppsBuildPage, {
  getLayout: (page) => (
    <AppLayout footer={(page.props as AppsBuildPageProps).mode === 'assistant' ? null : undefined}>
      {page}
    </AppLayout>
  ),
});
