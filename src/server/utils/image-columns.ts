/**
 * The `Image` columns a client-supplied image may set when a row is inserted. `id`, `postId`
 * and `index` are server-owned and deliberately absent: a write that needs them assigns them
 * explicitly from server state.
 */
export const CLIENT_IMAGE_COLUMNS = [
  'name',
  'url',
  'hash',
  'height',
  'width',
  'type',
  'mimeType',
  'sizeKB',
  'meta',
  'metadata',
] as const;

export type ClientImageColumn = (typeof CLIENT_IMAGE_COLUMNS)[number];

/**
 * Copies only the {@link CLIENT_IMAGE_COLUMNS} from `image`, so spreading the result into an
 * `Image` insert cannot carry a server-owned column. Keys that are absent or `undefined` stay
 * absent.
 */
export function pickClientImageColumns<T extends object>(
  image: T
): Pick<T, Extract<keyof T, ClientImageColumn>> {
  const picked: Record<string, unknown> = {};
  for (const column of CLIENT_IMAGE_COLUMNS) {
    const value = (image as Record<string, unknown>)[column];
    if (value !== undefined) picked[column] = value;
  }
  return picked as Pick<T, Extract<keyof T, ClientImageColumn>>;
}
