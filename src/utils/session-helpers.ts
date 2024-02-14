import { TokenUser } from 'next-auth';

export function extendedSessionUser(user: TokenUser) {
  return {
    ...user,
    isMember: user.tier != null,
    // TODO - computed db prop for mod levels
  };
}
