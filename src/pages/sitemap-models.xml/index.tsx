import { GetServerSideProps } from 'next';
import { ISitemapField, getServerSideSitemapLegacy } from 'next-sitemap';
import { pgDbRead } from '~/server/db/pgDb';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const query = await pgDbRead.cancellableQuery<{ id: number; name: string; updatedAt: Date }>(`
    SELECT id, name, COALESCE("lastVersionAt", "publishedAt") as "updatedAt"
    FROM "Model" m
    JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = 'AllTime'
    WHERE m."status" = 'Published' AND m."nsfwLevel" = 1
    ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"
    LIMIT 1000;
  `);
  ctx.res.on('close', query.cancel);
  const data = await query.result();

  const fields: ISitemapField[] = data.map((model) => ({
    loc: `${getBaseUrl()}/models/${model.id}/${slugit(model.name)}`,
    lastmod: model.updatedAt?.toISOString() ?? new Date().toISOString(),
  }));

  return getServerSideSitemapLegacy(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function ModelsSitemap() {}
