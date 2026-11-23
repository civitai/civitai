/**
 * The raw statements a mocked Prisma client received that touch the version showcase table, with
 * their bound values flattened (a `Prisma.join` list contributes its items). Lets a test check that
 * a path reached the showcase at the database boundary instead of mocking the showcase service.
 *
 *   expect(showcaseQueries(dbMock.dbRead.$queryRaw).flatMap((q) => q.values)).toContain(POST_ID);
 */
export function showcaseQueries(queryRaw: { mock: { calls: unknown[][] } }) {
  return queryRaw.mock.calls.flatMap(([query, ...values]) => {
    const strings = Array.isArray(query)
      ? (query as string[])
      : (query as { strings?: string[] } | undefined)?.strings ?? [];
    const sql = strings.join('?');
    if (!sql.includes('"ModelVersionShowcaseItem"')) return [];
    const bound = Array.isArray(query)
      ? values
      : (query as { values?: unknown[] } | undefined)?.values ?? [];
    return [{ sql, values: bound.flatMap(flatten) }];
  });
}

function flatten(value: unknown): unknown[] {
  if (value && typeof value === 'object' && 'values' in value && 'strings' in value)
    return ((value as { values: unknown[] }).values ?? []).flatMap(flatten);
  return [value];
}

/** The calls a mocked client received other than the showcase ones, for a test that counts them. */
export function withoutShowcaseQueries<C extends unknown[]>(queryRaw: { mock: { calls: C[] } }) {
  return queryRaw.mock.calls.filter(([query]) => {
    const strings = Array.isArray(query)
      ? (query as string[])
      : (query as { strings?: string[] } | undefined)?.strings ?? [];
    return !strings.join('?').includes('"ModelVersionShowcaseItem"');
  });
}

type ShowcaseRow = {
  modelVersionId: number;
  modelId: number;
  imageId: number;
  site: 'com' | 'red';
  source: 'Owner' | 'Community';
  position?: number | null;
  excluded?: boolean;
};
type CommunityImage = {
  id: number;
  modelVersionId: number;
  site: 'com' | 'red';
  nsfwLevel: number;
  userId?: number;
  url?: string;
  [key: string]: unknown;
};

/**
 * Answers a mocked client's raw reads of the version showcase from a fixture, as the database
 * would: its rows, the community images that pass the filters, and their live ratings. Any other
 * statement goes to `fallback`. Lets a test serve a curated showcase through the real service.
 */
export function answerShowcaseQueries(
  queryRaw: { mockImplementation: (fn: (...args: never[]) => unknown) => unknown },
  { rows = [], community = [] }: { rows?: ShowcaseRow[]; community?: CommunityImage[] },
  fallback: (query: unknown, ...values: unknown[]) => unknown = async () => []
) {
  queryRaw.mockImplementation((async (query: unknown, ...values: unknown[]) => {
    const sql = (
      Array.isArray(query) ? (query as string[]) : (query as { strings?: string[] })?.strings ?? []
    ).join('?');
    if (sql.includes('SELECT DISTINCT s."modelVersionId", mv."modelId", s."imageId"'))
      return rows
        .filter((row) => row.source === 'Community')
        .map(({ modelVersionId, modelId, imageId }) => ({ modelVersionId, modelId, imageId }));
    if (sql.includes('SELECT s."modelVersionId", s."imageId", s.site, s.source'))
      return rows.map(({ modelId: _modelId, position = null, excluded = false, ...row }) => ({
        ...row,
        position,
        excluded,
      }));
    if (sql.includes('u.username AS "authorUsername"'))
      return community.map((image) => ({
        userId: 0,
        url: `u${image.id}`,
        type: 'image',
        width: 1,
        height: 1,
        authorUsername: null,
        galleryHiddenUserIds: null,
        ...image,
      }));
    if (sql.includes('SELECT i.id, i."nsfwLevel" FROM "Image" i'))
      return community.map(({ id, nsfwLevel }) => ({ id, nsfwLevel }));
    return fallback(query, ...values);
  }) as never);
}
