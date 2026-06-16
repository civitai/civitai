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
