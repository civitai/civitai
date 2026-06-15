/**
 * Sanitize a publisher-declared app name for display in the host-rendered trust
 * chrome (`AppBlockChrome`).
 *
 * The name comes from `manifest.name` — a PUBLISHER-controlled string. H2
 * promotes it from the invisible iframe `title` into the visible trust label
 * ("which sandboxed app is this"). The manifest validator only requires a
 * non-empty string, so without this the chrome would render unbounded,
 * unsanitized text in the exact surface meant to be a trust signal. This is
 * defense-in-depth at the render point: it also covers already-approved installs
 * in the DB, which bypass any future publish-time validator rule.
 *
 * It strips the mechanical UI-spoofing vectors:
 *  - control chars (\p{Cc}) and format chars (\p{Cf} — bidi RLO/LRO overrides,
 *    zero-width space/joiner, soft hyphen, …) that can reorder or hide displayed
 *    text or pad the accessible name a screen reader announces,
 *  - newlines / runs of whitespace (collapsed to single spaces),
 * and bounds the length (the visual ellipsis only clips the rendered box — the
 * accessible name a screen reader reads is the full string, so it must be capped
 * here too).
 *
 * It does NOT defend against name-based impersonation ("Civitai", "Official",
 * homoglyphs) — that needs a host-side verified-publisher / trustTier
 * differentiator, tracked separately.
 *
 * Returns the cleaned name, or `null` when nothing legible remains (the caller
 * falls back to the literal "App block").
 */
export const APP_CHROME_NAME_MAX = 64;

export function sanitizeAppChromeName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    // Remove format chars (\p{Cf}: bidi RLO/LRO overrides, zero-width space/joiner,
    // soft hyphen, …) outright — they have no width and only reorder/hide text.
    .replace(/\p{Cf}/gu, '')
    // Turn control chars (\p{Cc}: incl. newlines/tabs AND e.g. bell) into spaces so
    // words don't fuse, then collapse whitespace runs to a single space.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= APP_CHROME_NAME_MAX) return cleaned;
  return cleaned.slice(0, APP_CHROME_NAME_MAX - 1).trimEnd() + '…';
}
