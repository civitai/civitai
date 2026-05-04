import type { GetServerSidePropsContext } from 'next';

export type SitemapField = {
  loc: string;
  lastmod?: string;
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const SITEMAPINDEX_OPEN = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

function writeXml(ctx: GetServerSidePropsContext, body: string) {
  ctx.res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  ctx.res.write(`${XML_HEADER}${body}`);
  ctx.res.end();
}

export function respondWithSitemap(ctx: GetServerSidePropsContext, fields: SitemapField[]) {
  const urls = fields
    .map(({ loc, lastmod }) => {
      const lastmodTag = lastmod ? `<lastmod>${lastmod}</lastmod>` : '';
      return `<url><loc>${loc}</loc>${lastmodTag}</url>`;
    })
    .join('');
  writeXml(ctx, `${URLSET_OPEN}${urls}</urlset>`);
  return { props: {} };
}

export function respondWithSitemapIndex(ctx: GetServerSidePropsContext, locs: string[]) {
  const sitemaps = locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('');
  writeXml(ctx, `${SITEMAPINDEX_OPEN}${sitemaps}</sitemapindex>`);
  return { props: {} };
}

export function respondWithText(ctx: GetServerSidePropsContext, body: string) {
  ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  ctx.res.write(body);
  ctx.res.end();
  return { props: {} };
}
