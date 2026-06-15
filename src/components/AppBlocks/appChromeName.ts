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
    // NFC first so legit base+mark sequences (Vietnamese, etc.) collapse to
    // precomposed code points — minimises the combining-mark count we then bound.
    .normalize('NFC')
    // Remove format chars (\p{Cf}: bidi RLO/LRO overrides, zero-width space/joiner,
    // soft hyphen, BOM, tag chars, …) outright — they have no width and only
    // reorder/hide text.
    .replace(/\p{Cf}/gu, '')
    // Turn control chars (\p{Cc}: incl. newlines/tabs AND e.g. bell) into spaces so
    // words don't fuse, then collapse whitespace runs to a single space.
    .replace(/\p{Cc}/gu, ' ')
    // Cap runs of combining marks (\p{M}) at 2 — kills the "Zalgo" overflow vector
    // (dozens of stacked diacritics bleeding over adjacent host UI) while keeping
    // legitimate scripts that need 1–2 marks per base. We bound, not strip, so we
    // don't mangle real non-Latin names.
    .replace(/\p{M}+/gu, (run) => [...run].slice(0, 2).join(''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return null;
  // Bound by CODE POINT (spread), never by UTF-16 code unit — a code-unit slice can
  // cut a surrogate pair in half, leaving a lone surrogate that renders as �. Strip
  // any combining mark left dangling at the cut so the ellipsis isn't decorated.
  const codepoints = [...cleaned];
  if (codepoints.length <= APP_CHROME_NAME_MAX) return cleaned;
  return (
    codepoints
      .slice(0, APP_CHROME_NAME_MAX - 1)
      .join('')
      .replace(/\p{M}+$/u, '')
      .trimEnd() + '…'
  );
}
