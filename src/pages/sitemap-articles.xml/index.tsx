import type { GetServerSideProps } from 'next';
import { pgDbRead } from '~/server/db/pgDb';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { slugit } from '~/utils/string-helpers';

// Inclusion rules mirror what `Gated` decides on the article detail page.
// `Article.nsfw` exists in the schema but is not passed to `Gated`, so the
// rule is purely based on `nsfwLevel`:
//   - Green canonical = has the public (PG) bit set
//   - Red/blue canonical = has no safe bits (no PG and no PG-13 — i.e. only
//     R/X/XXX bits or higher) AND not unrated
// A multi-level article like nsfwLevel=7 (PG|PG13|R) is canonical on green
// because the PG bit is set; it should NOT appear in the red sitemap even
// though it has the R bit.
const sqlByColor = {
  green: `
    SELECT a.id, a.title, a."publishedAt"
    FROM "Article" a
    WHERE a.status = 'Published'
      AND a."publishedAt" IS NOT NULL
      AND (a."nsfwLevel" & $1) != 0
    ORDER BY a."publishedAt" DESC
    LIMIT 1000;
  `,
  nsfw: `
    SELECT a.id, a.title, a."publishedAt"
    FROM "Article" a
    WHERE a.status = 'Published'
      AND a."publishedAt" IS NOT NULL
      AND a."nsfwLevel" != 0
      AND (a."nsfwLevel" & $1) = 0
    ORDER BY a."publishedAt" DESC
    LIMIT 1000;
  `,
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const isGreen = color === 'green';
  const browsingLevel = isGreen ? publicBrowsingLevelsFlag : sfwBrowsingLevelsFlag;
  const sql = isGreen ? sqlByColor.green : sqlByColor.nsfw;

  const query = await pgDbRead.cancellableQuery<{
    id: number;
    title: string;
    publishedAt: Date | null;
  }>(sql, [browsingLevel]);
  ctx.res.on('close', query.cancel);
  const data = await query.result();

  const baseUrl = getBaseUrl(color);
  const fields: SitemapField[] = data.map((article) => ({
    loc: `${baseUrl}/articles/${article.id}/${slugit(article.title)}`,
    lastmod: article.publishedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ArticlesSitemap() {}
