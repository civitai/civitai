/**
 * A `$queryRaw` fake for `getSoldCounts`, answering only for the ids the statement was
 * actually given. A fake that returned every fixture count regardless would pass a caller
 * that queried the wrong ids, or none; this one reads that caller's page back as 0.
 *
 * Statements that are not the sold-count query resolve to `other(...)`, `[]` by default.
 */
export const soldCountsFake =
  (counts: Record<number, number>, other: (...args: unknown[]) => unknown = () => []) =>
  async (strings: readonly string[], ...values: unknown[]) => {
    if (!strings.join('?').includes('"UserCosmeticShopPurchases"'))
      return other(strings, ...values);
    const ids = values.find(Array.isArray) as number[] | undefined;
    if (!ids) throw new Error('soldCountsFake: the sold-count statement carried no id array');
    return ids
      .filter((id) => counts[id] !== undefined)
      .map((id) => ({ shopItemId: id, sold: counts[id] }));
  };
