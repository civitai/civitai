/** Whitespace-only counts as unset: a bare key in a ConfigMap arrives as an empty string. */
export function isConfiguredSecret(secret: string | null | undefined): secret is string {
  return !!secret && secret.trim() !== '';
}

export function matchesConfiguredSecret(presented: unknown, secret: string | null | undefined) {
  return isConfiguredSecret(secret) && presented === secret;
}
