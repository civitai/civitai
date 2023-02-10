import { useSession } from 'next-auth/react';

export function useCurrentUser() {
  const { data } = useSession();
  if (!data || !data.user) return null;

  return  {
    ...data.user,
    isMember: data.user.tier != null,
  };
}
