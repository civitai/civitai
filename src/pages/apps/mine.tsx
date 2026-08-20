import { Button } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { MyAppsBody } from '~/components/Apps/MyAppsBody';
import { MY_APPS_CONTAINER_SIZE } from '~/components/Apps/myAppsView';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * `/apps/mine` — every app the viewer OWNS or holds an ACCEPTED collaborator seat on,
 * with that app's submission history nested inside its row.
 *
 * 🔴 THE COLLABORATOR'S OWN APP LIST. `/apps/my-submissions` could not serve this: it was
 * scoped to a publish request's `submittedByUserId`, so a collaborator (who submitted
 * nothing) saw an empty page, and even an OWNER lost a listing they acquired by transfer
 * or moderator claim. This page reads `appListings.listMine`, which resolves ownership
 * canonically and unions in accepted seats. `/apps/my-submissions` now 301s here.
 *
 * 🔴 GATED ON `appBlocksAuthor` ONLY — deliberately NOT on `appBlocks`. The page this
 * absorbed additionally required the marketplace-visibility flag and returned `NotFound`
 * without it, which meant narrowing STORE access also hid an author's own apps from them.
 * Authorship and store visibility are different questions; only the author flag belongs on
 * an authoring surface.
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

export default function MyAppsPage() {
  return (
    <>
      <Meta title="My apps — Civitai Apps" deIndex />
      <AppsPageLayout
        size={MY_APPS_CONTAINER_SIZE}
        title="My apps"
        subtitle="Apps you own and apps you collaborate on, on-site and external. Open a row to see its submission history."
        actions={
          <Button component={Link} href="/apps/submit" rightSection={<IconArrowRight size={16} />}>
            Submit a new app
          </Button>
        }
      >
        <MyAppsBody />
      </AppsPageLayout>
    </>
  );
}
