import type { GetServerSideProps } from 'next';
import { pgDbRead } from '~/server/db/pgDb';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  publicBrowsingLevelsFlag,
  sitemapNsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const browsingLevel =
    color === 'green' ? publicBrowsingLevelsFlag : sitemapNsfwBrowsingLevelsFlag;

  const query = await pgDbRead.cancellableQuery<{ id: number; name: string; updatedAt: Date }>(
    `
    SELECT m.id, m.name, COALESCE(m."lastVersionAt", m."publishedAt") as "updatedAt"
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."status" = 'Published' AND (mm."nsfwLevel" & $1) != 0
    ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"
    LIMIT 1000;
  `,
    [browsingLevel]
  );
  ctx.res.on('close', query.cancel);
  const data = await query.result();

  const baseUrl = getBaseUrl(color);
  const fields: SitemapField[] = data.map((model) => ({
    loc: `${baseUrl}/models/${model.id}/${slugit(model.name)}`,
    lastmod: model.updatedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ModelsSitemap() {}
