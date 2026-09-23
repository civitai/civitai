import clsx from 'clsx';
import type { ReactNode } from 'react';
import { UserLink } from '~/components/User/UserLink';
import { UserHoverCard } from '~/components/UserAvatar/UserHoverCard';

export function CrucibleUserLink({
  user,
  className,
  children,
}: {
  user: { id: number; username: string | null; deletedAt?: Date | null };
  className?: string;
  children: ReactNode;
}) {
  return (
    <UserHoverCard user={user}>
      <span className={clsx('inline-flex min-w-0', className)}>
        <UserLink username={user.username} deletedAt={user.deletedAt}>
          {/* Entry cards open on click; following the profile link must not open the entry too. */}
          <a
            className="inline-flex min-w-0 items-center gap-3 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </a>
        </UserLink>
      </span>
    </UserHoverCard>
  );
}
