import type { SessionUser } from './types';

// Roles are app-namespaced as `app:role` (e.g. "moderator:volunteer"); each app reads only its own slice.
export const APP_ROLE_SEPARATOR = ':';

export function appRole(app: string, role: string): string {
  return `${app}${APP_ROLE_SEPARATOR}${role}`;
}

export function appRoles(user: Pick<SessionUser, 'roles'> | null | undefined, app: string): string[] {
  const prefix = app + APP_ROLE_SEPARATOR;
  const roles = new Set<string>();
  for (const role of user?.roles ?? []) {
    if (role.startsWith(prefix)) roles.add(role.slice(prefix.length));
  }
  return [...roles];
}

export function hasAppRole(
  user: Pick<SessionUser, 'roles'> | null | undefined,
  app: string,
  role: string
): boolean {
  return (user?.roles ?? []).includes(appRole(app, role));
}
