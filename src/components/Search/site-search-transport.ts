/**
 * Which way the browser's site search goes, written by `FeatureFlagsProvider` from the
 * `siteSearchProxy` flag. A leaf, so the provider does not pull the search client into every page.
 */
let proxyEnabled = false;

export function setSiteSearchProxyEnabled(enabled: boolean) {
  proxyEnabled = enabled;
}

export const isSiteSearchProxyEnabled = () => proxyEnabled;
