import { useMemo, useState } from 'react';
import { REVIEW_HOST_LABEL_PREFIX } from '~/shared/constants/app-frame-hosts.constants';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * App Blocks — the VERSIONED FRAME PATH.
 *
 * A published app is served at `https://<slug>.<APPS_DOMAIN>/`. The app host also serves
 * the CURRENT approved version at `https://<slug>.<APPS_DOMAIN>/v/<sha>/`, and answers
 * `/v/<any other sha>/…` with a redirect to the current one. It serves a service worker
 * script ONLY under `/v/<current sha>/`, and never sends `Service-Worker-Allowed`, so a
 * worker's scope is at most one version's path. Framing an app at its version path
 * therefore means a worker installed by one version can never control the documents of
 * the next: the new version loads at `/v/<new sha>/`, outside the old worker's scope.
 *
 * 🔴 THE MANIFEST'S STORED `iframe.src` STAYS THE ROOT. `stampCanonicalIframeSrc`
 * (`~/server/services/blocks/manifest-normalize`) and every gate keyed on it (the submit
 * check, the manifest validator's origin binding, the git-push webhook) require exactly
 * `https://<slug>.<APPS_DOMAIN>/`. The version path is added HERE, by the host, when it
 * builds the frame `src` — never written back.
 *
 * 🔴 ONLY THE PATH CHANGES, NEVER THE ORIGIN. Everything keyed on the frame origin
 * (`expectedOrigin`, the postMessage target, `mayGrantSameOrigin`, CORS allowed origins)
 * sees the same value with or without it.
 *
 * BACKWARDS COMPATIBLE. Absolute `/assets/…` URLs (Vite's default) keep resolving at the
 * root, which serves the current version; relative ones resolve under the version path.
 * An app that routes on its own `location.pathname` would see `/v/<sha>/` instead of `/`;
 * no published app did when this shipped (the whole app bucket was scanned, see the PR).
 *
 * Returns `baseSrc` UNCHANGED unless every one of these holds:
 *   - `enabled` (the viewer's `appBlocksVersionedFramePath` flag);
 *   - `sha` is a full 40-hex commit sha (`AppBlock.currentVersionSha`);
 *   - `baseSrc` is an https URL with no credentials, port, query or fragment, whose path
 *     is exactly `/` — the canonical published src and nothing else (a dev-tunnel or
 *     preview entry URL carries a token and is never rewritten);
 *   - its host is not a review host (`review-<sha16>.…`), which serves no version path.
 */
const SHA_RE = /^[0-9a-f]{40}$/;

export function versionedFrameSrc(
  baseSrc: string,
  sha: string | null | undefined,
  enabled: boolean
): string {
  if (!enabled || typeof sha !== 'string' || !SHA_RE.test(sha)) return baseSrc;
  let url: URL;
  try {
    url = new URL(baseSrc);
  } catch {
    return baseSrc;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return baseSrc;
  if (url.pathname !== '/' || url.search || url.hash) return baseSrc;
  if (url.hostname.split('.')[0]?.startsWith(REVIEW_HOST_LABEL_PREFIX)) return baseSrc;
  url.pathname = `/v/${sha}/`;
  return url.toString();
}

/**
 * The frame `src` a published-app host renders: `versionedFrameSrc` with the viewer's
 * flag. The flag is FROZEN FOR THE MOUNT, like `useAppFrameOriginPolicy`: a flags overlay
 * that arrived after the frame loaded must not move the `src` of a running app (that is a
 * navigation, and it would discard the app's state). A change of `baseSrc` or `sha` (a
 * soft navigation to another app, a new version) still re-navigates, as today.
 */
export function useVersionedFrameSrc(baseSrc: string, sha: string | null | undefined): string {
  const features = useOptionalFeatureFlags();
  const [enabled] = useState(() => features?.appBlocksVersionedFramePath === true);
  return useMemo(() => versionedFrameSrc(baseSrc, sha, enabled), [baseSrc, sha, enabled]);
}
