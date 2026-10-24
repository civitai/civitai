const HTML_SIGNIFICANT = /[<>&\u2028\u2029]/g;

/**
 * JSON for the body of an inline `<script>` element. `JSON.stringify` leaves `<` as-is, so a
 * string value containing `</script>` would end the element early; the escapes are valid JSON and
 * parse back to the same value.
 */
export function serializeJsonLd(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(
    HTML_SIGNIFICANT,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
