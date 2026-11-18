/**
 * App Blocks manifest normalization — platform-owned fields.
 *
 * Pure module (no env / Prisma / I/O) so it can be imported statically and
 * unit-tested without booting the server runtime.
 *
 * `iframe.src` is a PLATFORM-OWNED manifest field, NOT developer-authored. The
 * App Blocks runtime serves every block from the canonical per-app subdomain
 * root, and every gate — the submit check, the BlockManifestValidator origin
 * binding, and the git-push webhook — requires exactly
 * `https://<slug>.<APPS_DOMAIN>/`. There is no other valid value. So rather than
 * make a developer hand-author a subdomain that doesn't exist until their app is
 * approved (and reject them, after a multi-MiB upload, if they get it wrong), we
 * DERIVE + stamp it server-side. This mirrors how `trustTier` is server-owned:
 * a publisher can't self-declare it either (publish-request.service.ts).
 */

/** The one canonical iframe.src for a block: the per-app subdomain root. */
export function canonicalIframeSrc(slug: string, appsDomain: string): string {
  return `https://${slug}.${appsDomain}/`;
}

/**
 * Overwrite `manifest.iframe.src` with the canonical value, creating the
 * `iframe` object if absent. Mutates AND returns the same manifest object — the
 * submit + approve paths already mutate the manifest in place (e.g.
 * `manifest.trustTier = …`), so this matches the established idiom. Any
 * developer-supplied `iframe.src` is overwritten; all other `iframe` fields
 * (`minHeight`, `sandbox`, …) are preserved — those stay developer-authored.
 */
export function stampCanonicalIframeSrc(
  manifest: Record<string, unknown>,
  slug: string,
  appsDomain: string
): Record<string, unknown> {
  const existing =
    manifest.iframe && typeof manifest.iframe === 'object' && !Array.isArray(manifest.iframe)
      ? (manifest.iframe as Record<string, unknown>)
      : {};
  manifest.iframe = { ...existing, src: canonicalIframeSrc(slug, appsDomain) };
  return manifest;
}

/**
 * Manifest string fields whose length BlockManifestValidator checks AFTER trimming
 * (`tagline` ≤ MANIFEST_TAGLINE_MAX_LENGTH, `repository` ≤ MAX_REPOSITORY_URL_LENGTH).
 * Stored as measured, so a whitespace-padded value cannot carry the padding past the
 * cap into the stored manifest and from there into the published release manifest.
 */
export const TRIMMED_MANIFEST_STRING_FIELDS = ['tagline', 'repository'] as const;

/**
 * Trim each {@link TRIMMED_MANIFEST_STRING_FIELDS} value that is a string. Non-string
 * values are left for the validator to reject. Mutates AND returns the same manifest
 * object, like {@link stampCanonicalIframeSrc}. Every path that stores a manifest calls
 * this before the write.
 */
export function trimManifestStringFields(
  manifest: Record<string, unknown>
): Record<string, unknown> {
  for (const key of TRIMMED_MANIFEST_STRING_FIELDS) {
    const value = manifest[key];
    if (typeof value === 'string') manifest[key] = value.trim();
  }
  return manifest;
}
