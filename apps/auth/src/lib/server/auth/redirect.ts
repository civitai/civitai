// Hub-local wrapper over @civitai/auth's shared login-redirect contract. Stays SYNC + DB-free: the origin
// policy is injected. The DEFAULT is the static `isCivitaiOrigin` (owned-eTLD+1 ownership) — the
// security-floor backstop, and what the unit test exercises. Callers that want the registry-aware policy
// (registered spoke hosts ∪ that backstop) resolve `buildPostLoginOriginCheck()` (oauth/first-party.ts —
// DB-backed, cached) and pass it as `isAllowedOrigin`. Keeping the DB read OUT of here keeps this module (and
// its security test) free of a DB dependency. The returnUrl/recursion/sync contract lives in the package.
import {
  readReturnUrl,
  readSync,
  isCivitaiOrigin,
  buildPostLoginRedirect as buildPostLoginRedirectBase,
} from '@civitai/auth';

export { readReturnUrl, readSync };

export function buildPostLoginRedirect(
  returnUrl: string,
  sync: string | null,
  origin: string,
  dev: boolean,
  isAllowedOrigin: (origin: string) => boolean = isCivitaiOrigin
): string {
  return buildPostLoginRedirectBase(returnUrl, sync, origin, {
    allowAllOrigins: dev,
    isAllowedOrigin,
  });
}
