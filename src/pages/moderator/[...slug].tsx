import type { GetServerSideProps } from 'next';
import { env } from '~/env/server';
import { resolveMigratedRoute } from '~/shared/constants/migrated-moderator-routes';

// Bounces migrated `/moderator/*` paths to the standalone moderator app. Dedicated `/moderator/*` pages
// that still live here take routing precedence over this catchall, so only deleted/migrated (or unknown)
// paths reach it — which is why deleting a page and adding its entry to the shared map are one change.
//
// The map is `~/shared/constants/migrated-moderator-routes` so `ModerationNav` can mark the same links
// as leaving the app without keeping a second list.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const slug = ctx.params?.slug;
  const path = Array.isArray(slug) ? slug.join('/') : slug ?? '';

  const target = resolveMigratedRoute(path);
  if (!target) return { notFound: true };

  const base = env.MODERATOR_APP_URL.replace(/\/$/, '');
  return {
    // Temporary during the transition — the route may come back or the mapping may change.
    redirect: { destination: `${base}/${target}`, permanent: false },
  };
};

// Never rendered — getServerSideProps always redirects or 404s.
export default function ModeratorRedirect() {
  return null;
}
