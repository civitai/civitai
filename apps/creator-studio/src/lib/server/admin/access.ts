import { hasAppRole, type SessionUser } from '@civitai/auth';

// `isModerator` is deliberately NOT a substitute: it is the content-moderation flag, and platform-wide
// revenue is a separate grant.
export const APP = 'creator-studio';
export const ADMIN_ROLE = 'admin';

export const isStudioAdmin = (user: Pick<SessionUser, 'roles'> | null | undefined): boolean =>
  hasAppRole(user, APP, ADMIN_ROLE);
