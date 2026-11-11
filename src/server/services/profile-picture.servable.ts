// A leaf with no imports: the profile reads that use it run under suites that mock `@prisma/client`.

/**
 * `servableProfilePictureSql` (profile-picture.sql.ts) for a picture already fetched without the lock fields: only a
 * Scanned one is served.
 */
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null
): T | null;
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null | undefined
): T | null | undefined;
export function servableProfilePicture<T extends { ingestion: string | null }>(
  picture: T | null | undefined
) {
  if (!picture) return picture;
  return picture.ingestion === 'Scanned' ? picture : null;
}
