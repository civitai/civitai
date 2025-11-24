import type { GetServerSideProps } from 'next';
import type { ISitemapField } from 'next-sitemap';
import { getServerSideSitemapLegacy } from 'next-sitemap';
import { pgDbRead } from '~/server/db/pgDb';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const query = await pgDbRead.cancellableQuery<{ id: number; name: string; updatedAt: Date }>(`
    SELECT m.id, m.name, COALESCE(m."lastVersionAt", m."publishedAt") as "updatedAt"
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."status" = 'Published' AND mm."nsfwLevel" = 1
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
