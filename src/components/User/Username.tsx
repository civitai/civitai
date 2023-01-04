export function Username({
  username,
  deletedAt,
}: {
  username: string | null;
  deletedAt?: Date | null;
}) {
  return !deletedAt ? username : '[deleted]';
}
