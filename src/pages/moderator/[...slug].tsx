import type { GetServerSideProps } from 'next';
import { env } from '~/env/server';

// Routes that have migrated from the main app's `/moderator/*` to the standalone moderator app
// (apps/moderator). As each page migrates and its main-app page is deleted, add its slug here so this
// catchall bounces it to the spoke instead of 404ing. Dedicated `/moderator/*` pages that still live in
// the main app take routing precedence over this catchall, so only deleted/migrated (or unknown) paths
// reach here.
//
// Key = path under `/moderator`; value = the corresponding base path on the moderator app. A request
// matches a key when it equals the key OR is nested under it (`key/...`), and the trailing sub-path is
// preserved (longest matching key wins). So one entry covers a whole subtree with dynamic segments
// (`images` → the /images hub + every [slug] mode + to-ingest; `scanner-audit` → scanner-audit/[mode]/
// [label]), and a renamed page maps cleanly (`image-tags` → `images/tags`).
const MIGRATED_ROUTES: Record<string, string> = {
  reports: 'reports',
  articles: 'articles',
  'article-rating-review': 'articles/ratings',
  'cosmetics/grant': 'cosmetics/grant',
  'comics-review': 'comics-review',
  blocklists: 'blocklists',
  // Audit tools now live under /audit in the spoke.
  auditor: 'audit/prompt-tester',
  'prompt-audit-test': 'audit/prohibited-prompts',
  'scanner-audit': 'audit/scanner-audit',
  images: 'images',
  // Renamed image task pages — legacy top-level path → new nested spoke path.
  'image-tags': 'images/tags',
  'image-rating-review': 'images/ratings',
  'downleveled-review': 'images/downleveled',
  'ingestion-error-review': 'images/ingestion-errors',
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const slug = ctx.params?.slug;
  const path = Array.isArray(slug) ? slug.join('/') : slug ?? '';

  const key = Object.keys(MIGRATED_ROUTES)
    .filter((k) => path === k || path.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return { notFound: true };

  const base = env.MODERATOR_APP_URL.replace(/\/$/, '');
  const target = MIGRATED_ROUTES[key] + path.slice(key.length);
  return {
    // Temporary during the transition — the route may come back or the mapping may change.
    redirect: { destination: `${base}/${target}`, permanent: false },
  };
};

// Never rendered — getServerSideProps always redirects or 404s.
export default function ModeratorRedirect() {
  return null;
}
