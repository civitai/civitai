/**
 * A `$queryRaw` implementation that answers the client image url ownership probe from `rows`,
 * using the keys, shop-write flag and userId the probe binds, so a probe with the wrong keys or
 * caller is seen. Every other raw query gets `[]`.
 */
export const imageUrlOwnersFake = (rows: { url: string; userId: number }[]) =>
  (async (strings: TemplateStringsArray, keys: unknown, shopWrite: unknown, userId: unknown) =>
    strings.join('').includes('url = ANY(') &&
    Array.isArray(keys) &&
    rows.some((row) => keys.includes(row.url) && (shopWrite === true || row.userId !== userId))
      ? [{}]
      : []) as never;

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
