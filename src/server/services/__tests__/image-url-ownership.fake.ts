/**
 * A `$queryRaw` implementation that answers the client image url probes from `rows`, using the
 * keys and users each probe binds, so a probe with the wrong keys or users is seen: the ownership
 * probe (rows of another user) and the issued-key probe (rows of the allowed users). Every other
 * raw query gets `[]`.
 */
export const imageUrlOwnersFake = (rows: { url: string; userId: number }[]) =>
  (async (strings: TemplateStringsArray, keys: unknown, users: unknown) => {
    const sql = strings.join('');
    if (!sql.includes('url = ANY(') || !Array.isArray(keys)) return [];
    if (Array.isArray(users))
      return rows
        .filter((row) => keys.includes(row.url) && users.includes(row.userId))
        .map(({ url }) => ({ url }));
    return rows.some((row) => keys.includes(row.url) && row.userId !== users) ? [{}] : [];
  }) as never;
