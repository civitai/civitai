/**
 * A `$queryRaw` implementation that answers the client image url probes from `rows`, using the
 * keys and users each probe binds, so a probe with the wrong keys or users is seen: the ownership
 * probe (rows of another user, or any row for a shop write) and the issued-key probe (rows of the
 * allowed users). Every other raw query gets `[]`.
 */
export const imageUrlOwnersFake = (rows: { url: string; userId: number }[]) =>
  (async (strings: TemplateStringsArray, keys: unknown, second: unknown, third: unknown) => {
    const sql = strings.join('');
    if (!sql.includes('url = ANY(') || !Array.isArray(keys)) return [];
    if (Array.isArray(second))
      return rows
        .filter((row) => keys.includes(row.url) && second.includes(row.userId))
        .map(({ url }) => ({ url }));
    // The ownership probe binds keys, then the caller; the full one has the shop-write flag first.
    const [shopWrite, caller] = typeof second === 'number' ? [false, second] : [second, third];
    return rows.some(
      (row) => keys.includes(row.url) && (shopWrite === true || row.userId !== caller)
    )
      ? [{}]
      : [];
  }) as never;

/**
 * A `$queryRaw` implementation that answers the ownership probe as "already used", recording the
 * values it was bound with (SQL fragments left out) into `probes`. Every other raw query gets `[]`.
 */
export const takenImageKeyFake = (probes: unknown[][] = []) =>
  (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('').includes('FROM "ItemDefinition" WHERE')) return [];
    probes.push(
      values.filter((value) => !(value && typeof value === 'object' && 'strings' in value))
    );
    return [{}];
  }) as never;
