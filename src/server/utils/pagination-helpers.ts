import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest } from 'next';
import { isProd } from '~/env/other';
import type { PaginationInput } from '~/server/schema/base.schema';
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
  const totalPages = pageSize && totalItems ? Math.ceil((totalItems as number) / pageSize) : 1;

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
    isProd ? `https://${req.headers.host as string}` : 'http://localhost:3000'
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

export async function getPagedData<TQuery extends PaginationInput, TData>(
  { page, limit, ...rest }: TQuery,
  fn: (
    args: { skip?: number; take?: number } & Omit<TQuery, 'page' | 'limit'>
  ) => Promise<{ items: TData; count?: number | bigint }>
) {
  const take = !page ? undefined : limit;
  const skip = !page ? undefined : (page - 1) * limit;

  const { items, count } = await fn({ skip, take, ...rest });
  const totalItems = Number(count) ?? 0;

  return {
    currentPage: page,
    pageSize: take,
    totalPages: !!take && !!count ? Math.ceil(totalItems / take) : 1,
    totalItems,
    items,
  };
}

type SortOrder = 'ASC' | 'DESC';

interface SortField {
  field: string;
  order: SortOrder;
}

function parseSortString(sortString: string): SortField[] {
  return sortString.split(',').map((part) => {
    const [field, order = 'ASC'] = part.trim().split(' ').filter(Boolean);
    return { field, order: order.toUpperCase() as SortOrder };
  });
}

function parseCursor(fields: SortField[], cursor: string | number | Date | bigint) {
  if (typeof cursor === 'number' || typeof cursor === 'bigint' || cursor instanceof Date)
    return { [fields[0].field]: cursor };

  const values = cursor.split('|');
  const result: Record<string, number | Date> = {};
  for (let i = 0; i < fields.length; i++) {
    const value = values[i];
    if (value.includes('-')) result[fields[i].field] = dayjs.utc(value).toDate();
    else result[fields[i].field] = parseInt(value, 10);
  }
  return result;
}

export function getCursor(sortString: string, cursor: string | number | bigint | Date | undefined) {
  const sortFields = parseSortString(sortString);
  let where: Prisma.Sql | undefined;
  if (cursor) {
    const cursors = parseCursor(sortFields, cursor);
    const conditions: Prisma.Sql[] = [];

    for (let i = 0; i < sortFields.length; i++) {
      const conditionParts: Prisma.Sql[] = [];
      for (let j = 0; j <= i; j++) {
        const { field, order } = sortFields[j];
        let operator = j < i ? '=' : order === 'DESC' ? '<' : '>=';
        if (j < i) operator = '=';

        conditionParts.push(
          Prisma.sql`${Prisma.raw(field)} ${Prisma.raw(operator)} ${cursors[field]}`
        );
      }
      conditions.push(Prisma.sql`(${Prisma.join(conditionParts, ' AND ')})`);
    }

    where = Prisma.sql`(${Prisma.join(conditions, ' OR ')})`;
  }

  const sortProps = sortFields.map((x) => x.field);
  const prop =
    sortFields.length === 1 ? sortFields[0].field : `CONCAT(${sortProps.join(`, '|', `)})`;
  return {
    where,
    prop,
  };
}

export function getNextPage({
  req,
  currentPage,
  nextCursor,
}: {
  req: NextApiRequest;
  nextCursor?: string | bigint | Date;
  currentPage?: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd ? `https://${req.headers.host as string}` : 'http://localhost:3000'
  );

  const hasNextPage = !!nextCursor;
  if (!hasNextPage) return { baseUrl, nextPage: undefined };

  const queryParams: MixedObject = { ...req.query };
  if (currentPage) queryParams.page = currentPage + 1;
  else queryParams.cursor = nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor;

  return { baseUrl, nextPage: `${baseUrl.origin}${baseUrl.pathname}?${QS.stringify(queryParams)}` };
}
