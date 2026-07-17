import { Code, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppsSubmitEditView } from '~/components/Apps/AppsSubmitEditView';
import { CliSubmitCta } from '~/components/Apps/CliSubmitCta';
import { ConnectSubmitForm } from '~/components/Apps/ConnectSubmitForm';
import { ExternalSubmitForm } from '~/components/Apps/ExternalSubmitForm';
import {
  SubmitModeSelector,
  type SubmitMode,
} from '~/components/Apps/SubmitModeSelector';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * /apps/submit — Submit a new app.
 *
 * The author first picks HOW they want to list: an on-platform **App**
 * (authored + submitted with the `civitai` CLI) or an **External link** (a
 * marketplace card that opens an off-site https URL). Each type is a large
 * selectable card; picking one reveals that flow, and a "choose a different
 * type" affordance returns to the selector.
 *
 * The App flow is CLI-only (the recommended path) — there is no manual ZIP
 * upload on this page.
 *
 * v0 gate: requires the dedicated `appBlocksAuthor` capability (mod/author).
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

export default function SubmitAppPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  // `null` = no type picked yet (the default — both cards shown).
  const [mode, setMode] = useState<SubmitMode | null>(null);

  // EDIT mode: `/apps/submit?edit=<listingId>` reuses this page + the External
  // wizard to edit an EXISTING off-site listing. When the param is present the
  // mode selector is bypassed entirely (an on-site App isn't edited here).
  const editId = typeof router.query.edit === 'string' ? router.query.edit : null;

  if (!features?.appBlocks) return <NotFound />;

  if (editId) return <AppsSubmitEditView listingId={editId} />;

  return (
    <>
      <Meta title="Submit an app — Civitai" deIndex />
      <AppsPageLayout
        size="sm"
        title="Submit an app"
        subtitle={
          mode === null ? (
            <>
              Choose how you want to list your app. Author an on-platform{' '}
              <strong>App</strong> with the <Code>civitai</Code> CLI, or list an{' '}
              <strong>External link</strong> that opens your off-site site. A moderator reviews
              every submission before it appears.
            </>
          ) : (
            <>
              Submitting{' '}
              {mode === 'external'
                ? 'an External link'
                : mode === 'connect'
                ? 'a Connect app'
                : 'an App'}
              .
            </>
          )
        }
      >
        {mode === null ? (
          <SubmitModeSelector onSelect={setMode} />
        ) : (
          <Stack gap="md">
            <UnstyledButton
              onClick={() => setMode(null)}
              data-testid="apps-submit-mode-back"
              aria-label="Choose a different type"
            >
              <Group gap={6}>
                <IconArrowLeft size={16} />
                <Text size="sm" c="dimmed">
                  Choose a different type
                </Text>
              </Group>
            </UnstyledButton>

            {mode === 'external' ? (
              <ExternalSubmitForm />
            ) : mode === 'connect' ? (
              <ConnectSubmitForm />
            ) : (
              <CliSubmitCta />
            )}
          </Stack>
        )}
      </AppsPageLayout>
    </>
  );
}
