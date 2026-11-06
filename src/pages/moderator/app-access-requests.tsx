import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { APP_ACCESS_REQUESTS_REVIEW_HREF } from '~/shared/constants/app-access-request.constants';

/**
 * MOVED: the App Access Requests queue is now the "Access requests" tab on `/apps/review`. This
 * route stays only so bookmarks and old links keep working. `requireModerator` still runs first, so
 * a non-moderator gets the same refusal as before rather than a redirect that then 404s.
 */
export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  resolver: async () => ({
    redirect: { destination: APP_ACCESS_REQUESTS_REVIEW_HREF, permanent: false },
  }),
});

// Never rendered — getServerSideProps always redirects.
export default function AppAccessRequestsRedirect() {
  return null;
}
