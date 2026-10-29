/**
 * A `$queryRaw` implementation that answers the client image url ownership probe from `rows`,
 * using the keys and userId the probe binds, so a probe with the wrong keys or caller is seen.
 * Every other raw query gets `[]`.
 */
export const imageUrlOwnersFake = (rows: { url: string; userId: number }[]) =>
  (async (strings: TemplateStringsArray, keys: unknown, userId: unknown) =>
    strings.join('').includes('url = ANY(') &&
    Array.isArray(keys) &&
    rows.some((row) => keys.includes(row.url) && row.userId !== userId)
      ? [{}]
      : []) as never;
