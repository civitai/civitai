import { NextApiRequest } from 'next';
import { isProd } from '~/env/other';
import { QS } from '~/utils/qs';

export const DEFAULT_PAGE_SIZE = 20;

export function getPagination(limit: number, page: number | undefined) {
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  return { take, skip };
}

export function getPagingData<T>(
  data: { count?: number; items: T[] },
  limit?: number,
  page?: number
) {
  const { count: totalItems = 0, items } = data;
  const currentPage = page ?? 1;
  const pageSize = limit ?? totalItems;
  const totalPages = pageSize && totalItems ? Math.ceil(totalItems / pageSize) : 1;

  return { items, totalItems, currentPage, pageSize, totalPages };
}

export function getPaginationLinks({
  req,
  totalPages,
  currentPage,
}: {
  req: NextApiRequest;
  totalPages: number;
  currentPage: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd ? `https://${req.headers.host}` : 'http://localhost:3000'
  );
  const hasNextPage = currentPage < totalPages;
  const hasPrevPage = totalPages > 1 && currentPage > 1;
  const nextPageQueryString = hasNextPage
    ? QS.stringify({
        ...req.query,
        page: currentPage + 1,
      })
    : '';
  const prevPageQueryString = hasPrevPage
    ? QS.stringify({
        ...req.query,
        page: currentPage - 1,
      })
    : '';

  const nextPage = hasNextPage
    ? `${baseUrl.origin}${baseUrl.pathname}?${nextPageQueryString}`
    : undefined;
  const prevPage = hasPrevPage
    ? `${baseUrl.origin}${baseUrl.pathname}?${prevPageQueryString}`
    : undefined;

  return { nextPage, prevPage, baseUrl };
}
