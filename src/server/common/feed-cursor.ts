// A feed-served page continues with the feed's own keyset cursor. It carries no `|` on
// purpose: getAllImagesIndex splits the client cursor on `|` and reads numbers, so a
// feed cursor handed to the Meilisearch path parses as offset 0, a clean restart.
const FEED_CURSOR_RE = /^feed:(\d{1,16}):(\d{1,12})$/;
export const encodeFeedCursor = (next: string) => `feed:${next.replace('|', ':')}`;
export function parseFeedCursor(cursor: unknown): string | undefined {
  const m = typeof cursor === 'string' ? FEED_CURSOR_RE.exec(cursor) : null;
  return m ? `${m[1]}|${m[2]}` : undefined;
}
