// They end or split a header line. Narrower than model-file-naming's set, which also strips the
// format characters that spoof a displayed name.
const controlChars = /\p{Cc}/gu;

/** RFC 5987 ext-value: percent-encode everything outside attr-char. */
function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * `attachment` disposition for a download name of any origin. The quoted `filename` is an ASCII
 * fallback with nothing that can close the quote or the line; `filename*` carries the real name.
 */
export function attachmentContentDisposition(fileName: string) {
  const clean = fileName.replace(controlChars, '');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}
