import type { GetServerSideProps } from 'next';
import { pgDbRead } from '~/server/db/pgDb';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { getArticleUrl } from '~/utils/string-helpers';

// Articles below this all-time engagement (reactions + comments + collects) are left out unless
// they are official, written by a moderator, or recent. Leaving one out doesn't deindex it —
// Google still reaches it through links — it just isn't advertised. Views are excluded because
// search traffic itself inflates them.
const ARTICLE_SITEMAP_MIN_ENGAGEMENT = 5;
// New articles haven't had time to collect engagement, and they are the ones that need discovering.
const ARTICLE_SITEMAP_RECENT_DAYS = 30;
// The sitemap protocol's per-file cap.
const MAX_URLS = 50_000;

// Domain membership mirrors what `Gated` decides on the article detail page. `Article.nsfw`
// exists in the schema but is not passed to `Gated`, so the rule is purely `nsfwLevel`:
//   - green canonical = has the public (PG) bit set
//   - red/blue canonical = has no safe bits (only R/X/XXX or higher) AND not unrated
// A multi-level article like nsfwLevel=7 (PG|PG13|R) is canonical on green because the PG bit is
// set; it should NOT appear in the red sitemap even though it has the R bit.
const domainFilter = {
  green: `(a."nsfwLevel" & $1) != 0`,
  nsfw: `a."nsfwLevel" != 0 AND (a."nsfwLevel" & $1) = 0`,
};

const engagement = `(mm."likeCount" + mm."heartCount" + mm."laughCount" + mm."cryCount" + mm."commentCount" + mm."collectedCount")`;

// Order is only the tiebreak for which URLs survive the cap: official first, then moderator
// articles, then by engagement.
const buildSql = (domain: keyof typeof domainFilter) => `
  SELECT a.id, a.title, a."publishedAt"
  FROM "Article" a
  JOIN "User" u ON u.id = a."userId"
  LEFT JOIN "ArticleMetric" mm ON mm."articleId" = a.id AND mm.timeframe = 'AllTime'
  WHERE a.status = 'Published'
    AND a."publishedAt" IS NOT NULL
    AND a.availability != 'Unsearchable'
    AND a.ingestion != 'Blocked'
    AND ${domainFilter[domain]}
    AND (
      a."isOfficial"
      OR u."isModerator" = true
      OR a."publishedAt" > now() - make_interval(days => $3)
      OR ${engagement} >= $2
    )
  ORDER BY a."isOfficial" DESC, (u."isModerator" = true) DESC, ${engagement} DESC NULLS LAST,
    a."publishedAt" DESC
  LIMIT ${MAX_URLS};
`;

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const isGreen = color === 'green';
  const browsingLevel = isGreen ? publicBrowsingLevelsFlag : sfwBrowsingLevelsFlag;

  const query = await pgDbRead.cancellableQuery<{
    id: number;
    title: string;
    publishedAt: Date | null;
  }>(buildSql(isGreen ? 'green' : 'nsfw'), [
    browsingLevel,
    ARTICLE_SITEMAP_MIN_ENGAGEMENT,
    ARTICLE_SITEMAP_RECENT_DAYS,
  ]);
  ctx.res.on('close', query.cancel);
  const data = await query.result();

  const baseUrl = getBaseUrl(color);
  const fields: SitemapField[] = data.map((article) => ({
    loc: `${baseUrl}${getArticleUrl({ id: article.id, title: article.title })}`,
    lastmod: article.publishedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ArticlesSitemap() {}
