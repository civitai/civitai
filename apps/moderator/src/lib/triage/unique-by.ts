/** One item per key, in the order keys are first seen (a row's source or label chips). */
export const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
};
