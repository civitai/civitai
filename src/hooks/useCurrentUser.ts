import { useCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { postgresSlugify } from '~/utils/string-helpers';

export function useCurrentUser() {
  const user = useCivitaiSessionContext();
  return user;
}

export const useIsSameUser = (username?: string | string[]) => {
  const currentUser = useCurrentUser();
  if (!username || !currentUser) return false;
  return (
    !!currentUser &&
    postgresSlugify(currentUser.username) ===
      postgresSlugify(typeof username === 'string' ? username : username[0])
  );
};
