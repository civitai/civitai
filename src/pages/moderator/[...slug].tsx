import type { GetServerSideProps } from 'next';
import { env } from '~/env/server';

// Routes that have migrated from the main app's `/moderator/*` to the standalone moderator app
// (apps/moderator). As each page migrates and its main-app page is deleted, add its slug here so this
// catchall bounces it to the spoke instead of 404ing. Dedicated `/moderator/*` pages that still live in
// the main app take routing precedence over this catchall, so only deleted/migrated (or unknown) paths
// reach here.
//
// Key = path under `/moderator` (no leading slash); value = the corresponding path on the moderator app.
const MIGRATED_ROUTES: Record<string, string> = {
  articles: 'articles',
  'article-rating-review': 'article-rating-review',
  'cosmetics/grant': 'cosmetics/grant',
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const slug = ctx.params?.slug;
  const path = Array.isArray(slug) ? slug.join('/') : slug ?? '';

  const target = MIGRATED_ROUTES[path];
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
