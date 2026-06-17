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

// Allow redirects only to a civitai eTLD+1 (civitai.com / civitai.red) or a subdomain of one. An exact
// host check — NOT a substring test: `origin.includes('civitai')` would accept civitai.evil.com,
// evil-civitai.com, civitai.com.attacker.io, etc. (open redirect). The leading dot in the suffix checks
// the subdomain boundary so `xcivitai.com` / `notcivitai.red` are rejected.
const isCivitaiOrigin = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'civitai.com' ||
    host.endsWith('.civitai.com') ||
    host === 'civitai.red' ||
    host.endsWith('.civitai.red')
  );
};

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
