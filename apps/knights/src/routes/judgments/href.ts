/** The /judgments URL for a status filter and page; the defaults stay out of the query. */
export function judgmentsHref(filter: string, page: number): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('status', filter);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/judgments?${query}` : '/judgments';
}
