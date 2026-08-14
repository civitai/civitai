import { Stack, Text } from '@mantine/core';
import Link from 'next/link';

import { AppInvitesBody } from '~/components/Apps/AppInvitesBody';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * `/apps/invites` — the invitee's pending app-collaborator invitations.
 *
 * 🔴 OWNER-INDEPENDENT BY CONSTRUCTION, and that is why it has to be its own route. A
 * pending invitee owns no app and holds no accepted seat, so every `/apps/<id>/…`
 * surface resolves their role, finds none, and refuses — there is literally no existing
 * page in the product that can show them their invitation. The invite notification
 * points here.
 *
 * 🔴 THE GATE IS THE AUTHOR FLAG, NOT OWNERSHIP — the same decision the collaborator
 * router documents for its two invitee-facing procs. Gating on "do you already own an
 * app" would make the very first invitation unacceptable, which is the whole feature.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocksAuthor) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    }
    if (!isAppDeveloper(session.user, { appBlocksAuthor: features?.appBlocksAuthor })) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

export default function AppInvitesPage() {
  return (
    <>
      <Meta title="App invitations — Civitai Apps" deIndex />
      <AppsPageLayout
        size={APPS_PAGE_WIDTHS['/apps/invites']}
        title="App invitations"
        subtitle="Invitations to collaborate on someone else's app."
      >
        <Stack gap="md">
          <AppInvitesBody />
          <Text size="sm" c="dimmed">
            Once you accept, the app appears in <Link href="/apps/mine">My apps</Link>.
          </Text>
        </Stack>
      </AppsPageLayout>
    </>
  );
}
