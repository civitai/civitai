import Link from 'next/link';

export function UserLink({
  username,
  deletedAt,
  children,
}: {
  children?: React.ReactNode;
  username: string | null;
  deletedAt?: Date | null;
}) {
  if (deletedAt || !username) return <>{children}</>;
  return (
    <Link href={`/user/${username}`} passHref>
      {children}
    </Link>
  );
}
