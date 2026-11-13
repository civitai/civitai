/** The counts, with the keys the server could not count beside them (an older server sends none). */
export function parseSidebarCounts(json: unknown): {
  counts: Record<string, number>;
  unavailable: string[];
} {
  const { unavailable, ...counts } = json as Record<string, unknown>;
  return {
    counts: counts as Record<string, number>,
    unavailable: Array.isArray(unavailable) ? (unavailable as string[]) : [],
  };
}
