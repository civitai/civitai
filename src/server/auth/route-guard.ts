// Page-level auth route guards, moved off the edge middleware (the thin hub civ-token can't resolve the full
// user in the edge runtime). Pure decision function so it's unit-testable; the side effects (the redirect + the
// async preview Flipt check) stay in the caller (_app getInitialProps).

type GuardSession = { user?: { isModerator?: boolean | null } | null } | null | undefined;

export type AuthGuardResult =
  | { redirect: string } // redirect the request here
  | { needsPreviewCheck: true } // logged-in non-mod on a preview deploy → caller runs the Flipt check
  | null; // allowed

export function resolveAuthGuard(
  path: string,
  session: GuardSession,
  env: { isProd: boolean; isPreview: boolean }
): AuthGuardResult {
  const isModerator = !!session?.user?.isModerator;
  const isLoggedIn = !!session?.user;
  const loginRedirect = `/login?returnUrl=${encodeURIComponent(path)}`;

  // /moderator (always) + /testing (prod only) require a moderator. Login can't grant the missing permission and
  // would loop back here, so an authed-but-unauthorized user is sent home instead of to login.
  if (
    (path.startsWith('/moderator') && !isModerator) ||
    (path.startsWith('/testing') && env.isProd && !isModerator)
  ) {
    return { redirect: isLoggedIn ? '/' : loginRedirect };
  }

  // Preview deploys gate every page behind login + the moderator/testers allowlist. The async Flipt check for a
  // logged-in non-moderator is deferred to the caller via `needsPreviewCheck`.
  if (env.isPreview && !path.startsWith('/login') && path !== '/preview-restricted') {
    if (!isLoggedIn) return { redirect: loginRedirect };
    if (!isModerator) return { needsPreviewCheck: true };
  }

  return null;
}
