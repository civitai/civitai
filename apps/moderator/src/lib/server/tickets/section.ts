export type CardSection<T> =
  | { status: 'ok'; rows: T[]; truncated: boolean }
  | { status: 'unavailable' };

/** One section of a card: a failing read is that section's `unavailable`, never the card's. */
export async function section<T>(
  scope: string,
  label: string,
  read: () => Promise<{ rows: T[]; truncated: boolean }>
): Promise<CardSection<T>> {
  try {
    return { status: 'ok', ...(await read()) };
  } catch (e) {
    console.error(`[tickets] ${scope} ${label} failed`, e);
    return { status: 'unavailable' };
  }
}

/** The first `limit` rows mapped; a read that asked for `limit + 1` tells a cut from a total. */
export const capped = <T, R>(rows: T[], limit: number, map: (row: T) => R) => ({
  rows: rows.slice(0, limit).map(map),
  truncated: rows.length > limit,
});
