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

// Inclusion rules mirror what `Gated` decides on the model detail page:
//   - Green canonical = NOT force-NSFW AND has the public (PG) bit set
//   - Red/blue canonical = force-NSFW (`m.nsfw = true`) OR has no safe bits
//     (no PG and no PG-13 — i.e. only R/X/XXX bits or higher)
// A multi-level model like nsfwLevel=7 (PG|PG13|R) is canonical on green
// because the PG bit is set; it should NOT appear in the red sitemap even
// though it has the R bit.
const sqlByColor = {
  green: `
    SELECT m.id, m.name, COALESCE(m."lastVersionAt", m."publishedAt") as "updatedAt"
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."status" = 'Published'
      AND m.nsfw = false
      AND (mm."nsfwLevel" & $1) != 0
    ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"
    LIMIT 1000;
  `,
  nsfw: `
    SELECT m.id, m.name, COALESCE(m."lastVersionAt", m."publishedAt") as "updatedAt"
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."status" = 'Published'
      AND mm."nsfwLevel" != 0
      AND (m.nsfw = true OR (mm."nsfwLevel" & $1) = 0)
    ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"
    LIMIT 1000;
  `,
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const isGreen = color === 'green';
  const browsingLevel = isGreen ? publicBrowsingLevelsFlag : sfwBrowsingLevelsFlag;
  const sql = isGreen ? sqlByColor.green : sqlByColor.nsfw;

  const query = await pgDbRead.cancellableQuery<{ id: number; name: string; updatedAt: Date }>(
    sql,
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
