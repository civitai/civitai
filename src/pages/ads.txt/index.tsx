import type { GetServerSideProps } from 'next';
import { ADS_TXT_FALLBACK_URL, getAdsTxt } from '~/server/services/ads-txt.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithText } from '~/server/utils/sitemap';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (getRequestDomainColor(ctx.req) !== 'green') return { notFound: true };
  try {
    const body = await getAdsTxt();
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return respondWithText(ctx, body);
  } catch {
    ctx.res.setHeader('Cache-Control', 'no-store');
    return { redirect: { destination: ADS_TXT_FALLBACK_URL, permanent: false } };
  }
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function AdsTxt() {}
