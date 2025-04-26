import { NextLink as Link } from '~/components/NextLink/NextLink';
import styles from './UserLink.module.scss';

export function UserLink({
  username,
  deletedAt,
  children,
}: {
  children?: React.ReactNode;
  username: string | null;
  deletedAt?: Date | null;
}) {
  if (deletedAt || !username) {
    return <span className={styles.deleted}>{children}</span>;
  }

  return (
    <Link legacyBehavior href={`/user/${username}`} passHref>
      <a className={styles.link}>{children}</a>
    </Link>
  );
}

