import type { GetServerSideProps } from 'next';
import { buildRobotsTxt } from '~/server/utils/robots';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { respondWithText } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const color = getRequestDomainColor(ctx.req) ?? 'green';
  const baseUrl = getBaseUrl(color);

  return respondWithText(ctx, buildRobotsTxt(baseUrl));
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function Robots() {}
