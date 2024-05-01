import { useCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { AuthorizationError } from '~/utils/errorHandling';
import { postgresSlugify } from '~/utils/string-helpers';

export function useCurrentUser() {
  const user = useCivitaiSessionContext();
  return user;
}

export function useCurrentUserRequired() {
  const currentUser = useCurrentUser();
  if (!currentUser) throw new AuthorizationError();
  return currentUser;
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
