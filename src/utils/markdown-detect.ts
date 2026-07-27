/**
 * Kept apart from `markdown-to-editor-html` so the paste handler can decide
 * whether to convert without pulling the unified/remark/rehype stack (~41 kB
 * brotli) into the editor chunk. Regexes only, no imports.
 */

/** Near-unambiguous: these appear in almost nothing except markdown. */
const STRONG_MARKDOWN = [
  /^```/m, // fenced code block
  /^\|[-: |]+\|[ \t]*$/m, // GFM table delimiter row
];

/**
 * Shared with things people paste constantly: `# ` starts a comment in Python,
 * YAML, shell and TOML, and `> ` starts a quoted email line. One alone is not
 * evidence — converting on it turned a pasted Python snippet into an invented
 * `<h1>` with its imports reflowed and `__init__` eaten as bold.
 */
const WEAK_MARKDOWN = [
  /^#{1,6} \S/m, // ATX heading, or a comment
  /^> \S/m, // blockquote, or a quoted reply
];

export function looksLikeMarkdown(text: string) {
  if (STRONG_MARKDOWN.some((pattern) => pattern.test(text))) return true;
  return WEAK_MARKDOWN.every((pattern) => pattern.test(text));
}
