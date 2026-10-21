import { AppAssistantWorkspace } from '~/components/Apps/AppAssistant/AppAssistantWorkspace';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { canAccessAppAssistant } from '~/shared/utils/app-blocks-access';

type AppAssistantPageProps = {
  /** The account may open dev tunnels, which the live preview runs on. */
  canPreview: boolean;
  /** The hosted sandbox service's base URL, or null when this deployment has none. */
  sandboxUrl: string | null;
  /** The assistant may start read-only subagents. */
  subagents: boolean;
  /** Replies run on the server runner (`appAssistantRemoteRunner`, the runner and the sandbox service configured). */
  remoteRunner: boolean;
};

export const getServerSideProps = createServerSideProps<AppAssistantPageProps>({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!canAccessAppAssistant(features)) return { notFound: true };
    const user = session?.user;
    if (!user)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
    if (user.bannedAt) return { redirect: { destination: '/', permanent: false } };

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

export default function AppAssistantPage({
  canPreview,
  sandboxUrl,
  subagents,
  remoteRunner,
}: AppAssistantPageProps) {
  return (
    <>
      <Meta title="App Assistant — Civitai Apps" deIndex />
      <AppsPageLayout
        title="App Assistant"
        subtitle="Describe an app and the assistant builds it while you watch."
      >
        <AppAssistantWorkspace
          canPreview={canPreview}
          sandboxUrl={sandboxUrl}
          subagents={subagents}
          remoteRunner={remoteRunner}
        />
      </AppsPageLayout>
    </>
  );
}

// No footer: the workspace fills the viewport. `Page` sets these on the component itself; the default
// export stays a plain function declaration so the `/apps` layout guards can parse it.
Page(AppAssistantPage, { footer: null, features: canAccessAppAssistant });
