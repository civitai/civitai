import { useCivitaiSessionContext } from '~/providers/CivitaiSessionProvider';

// export function useCurrentUser() {
//   const { data, update } = useSession();
//   if (!data || !data.user) return null;

//   return {
//     ...data.user,
//     isMember: data.user.tier != null,
//     refresh: update,
//   };
// }

export const useCurrentUser = () => useCivitaiSessionContext();
