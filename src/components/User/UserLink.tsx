import { NextLink as Link } from '~/components/NextLink/NextLink';

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
    <Link legacyBehavior href={`/user/${username}`} passHref>
      {children}
    </Link>
  );
}
