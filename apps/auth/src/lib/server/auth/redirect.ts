// Hub-local wrapper over @civitai/auth's shared login-redirect contract, with this hub's
// civitai-origin policy baked in. Routes keep their existing 4-arg call shape; the contract
// itself (returnUrl handling, recursion guard, sync re-attach) lives in the package and is
// unit-tested there.
import {
  readReturnUrl,
  readSync,
  buildPostLoginRedirect as buildPostLoginRedirectBase,
} from '@civitai/auth';

export { readReturnUrl, readSync };

// Allow redirects to any civitai-* origin (mirrors the main app's isSafeCrossOriginRedirect).
const isCivitaiOrigin = (origin: string) => origin.includes('civitai');

export function buildPostLoginRedirect(
  returnUrl: string,
  sync: string | null,
  origin: string,
  dev: boolean
): string {
  return buildPostLoginRedirectBase(returnUrl, sync, origin, {
    allowAllOrigins: dev,
    isAllowedOrigin: isCivitaiOrigin,
  });
}
