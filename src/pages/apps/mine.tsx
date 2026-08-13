import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { MyAppListingsPanel } from '~/components/Apps/MyAppListingsPanel';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * `/apps/mine` — every app the viewer OWNS or holds an ACCEPTED collaborator seat on.
 *
 * 🔴 THE COLLABORATOR'S OWN APP LIST. `/apps/my-submissions` cannot serve this: it is
 * scoped to a publish request's `submittedByUserId`, so a collaborator (who submitted
 * nothing) sees an empty page, and even an OWNER loses a listing they acquired by
 * transfer or moderator claim. This page reads `appListings.listMine`, which resolves
 * ownership canonically and unions in accepted seats.
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
        size={APPS_PAGE_WIDTHS['/apps/mine']}
        title="My apps"
        subtitle="Apps you own, and apps you collaborate on."
      >
        <MyAppListingsPanel />
      </AppsPageLayout>
    </>
  );
}
