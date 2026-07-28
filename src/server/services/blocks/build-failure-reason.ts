/**
 * Sanitizer for the App Blocks build-failure excerpt.
 *
 * WHY THIS EXISTS
 * ---------------
 * When an app's Tekton build fails, the only actionable information ("no
 * package-lock.json is committed", "tsc: Cannot find module ...") lives in a
 * build log the third-party author has no access to. The build callback now
 * carries an OPTIONAL `failureReason` excerpt so we can show the author WHY their
 * build failed instead of a bare "Build Failed".
 *
 * THAT EXCERPT IS TENANT-INFLUENCED CONTENT. It is a slice of the build log of
 * code the app author wrote -- an author who controls its bytes can put anything
 * in it (ANSI escapes, terminal control sequences, NUL, `</script>`, a 4 KB
 * blob). It arrives over an HMAC-authenticated channel, but authentication only
 * proves WHO sent it, never that the CONTENT is safe. So we re-sanitize
 * server-side, unconditionally, before it is ever persisted to
 * `app_block_publish_requests.deploy_detail`.
 *
 * The rendering path (React text nodes, never `dangerouslySetInnerHTML`) already
 * escapes, and the sibling `/api/v1/blocks/submissions` JSON path escapes on
 * serialization -- this is defence-in-depth so the STORED value is guaranteed
 * printable text + newlines regardless of who consumes it later (a log line, a
 * terminal `psql` session, a future non-React surface).
 *
 * IMPLEMENTATION NOTE: every escape/control character below is built from an
 * explicit `String.fromCharCode` constant rather than a `\xNN` literal, so this
 * source file contains no raw control bytes and the intent of each pattern stays
 * readable in a diff.
 */

/**
 * Hard ceiling on the sanitized excerpt. The pipeline contract caps
 * `failureReason` at 2000 chars; this is the independent server-side enforcement
 * (never trust the sender's cap).
 *
 * Budget for the STORED `deploy_detail`, which is `"Build <status>" + "\n\n" +
 * <excerpt>`: the status prefix is itself sliced to 60 chars, so the worst case is
 * 6 + 60 + 2 + 3000 = 3068 chars -- comfortably under the 4000-char total cap this
 * feature commits to. (`deploy_detail` is unbounded TEXT in Postgres, so the cap
 * is a product / DoS decision, not a schema limit.)
 */
export const MAX_BUILD_FAILURE_REASON_CHARS = 3000;

/** Appended when the excerpt is cut, so a reader knows they are not seeing it all. */
export const BUILD_FAILURE_TRUNCATION_MARKER = '\n... [truncated]';

/**
 * Defensive input ceiling applied BEFORE any regex work. The transport already
 * bounds this (MAX_BODY_BYTES = 8 KiB on the callback), but slicing first means
 * the sanitizer's cost is bounded by a constant no matter how it is called -- no
 * pathological-input CPU spike on the request path.
 */
const MAX_RAW_INPUT_CHARS = 8000;

const ESC = String.fromCharCode(0x1b); // ESC
const BEL = String.fromCharCode(0x07); // BEL (OSC terminator)
const CSI8 = String.fromCharCode(0x9b); // 8-bit CSI introducer

/**
 * Terminal escape sequences, stripped BEFORE the generic control-character pass.
 * Order matters: removing the bare ESC first would leave the human-visible
 * garbage tail (`[0m`, `]0;title`) behind as ordinary text.
 *
 * Every pattern is linear-time -- no nested quantifiers and no alternation inside
 * a repetition -- so this is not a ReDoS surface. (The OSC body class excludes
 * both terminators AND ESC, which is what removes the backtracking ambiguity.)
 */
const ESCAPE_SEQUENCE_PATTERNS: RegExp[] = [
  // OSC: ESC ] ... terminated by BEL or ST (ESC \), or unterminated at end of input.
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g'),
  // CSI: ESC [ params intermediates final -- SGR colours, cursor moves, erases.
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'),
  // 8-bit CSI (0x9B): same grammar, single-byte introducer.
  new RegExp(`${CSI8}[0-?]*[ -/]*[@-~]`, 'g'),
  // Any OTHER escape sequence, per the ECMA-48 grammar: ESC, zero or more
  // intermediate bytes (0x20-0x2F), one final byte (0x30-0x7E). Covers charset
  // selects (ESC ( B), ESC =, ESC >, ESC 7/8, and the two-character Fe escapes.
  // Runs AFTER the CSI/OSC patterns above, so it only sees what they left.
  // The two character classes are disjoint, so this is unambiguous + linear.
  new RegExp(`${ESC}[ -/]*[0-~]`, 'g'),
  // A lone/trailing ESC with nothing usable after it.
  new RegExp(ESC, 'g'),
];

/**
 * Is this code point allowed in the sanitized output?
 *
 * Allowed: `\n` (0x0A) and every printable character from 0x20 up, EXCEPT DEL
 * (0x7F) and the C1 control block (0x80-0x9F). `\t` and `\r` are rewritten before
 * this predicate runs, so they are correctly rejected here as leftovers.
 */
function isAllowedChar(code: number): boolean {
  if (code === 0x0a) return true; // newline -- the one control character we keep
  if (code < 0x20) return false; // C0 controls (NUL, BEL, VT, FF, ESC, ...)
  if (code === 0x7f) return false; // DEL
  if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  return true;
}

/** Drop every disallowed control character in one linear pass. */
function stripControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (isAllowedChar(text.charCodeAt(i))) out += text[i];
  }
  return out;
}

/**
 * Normalize an untrusted build-failure excerpt into printable text + `\n` only.
 *
 * Pure and total -- never throws, never touches I/O, and returns `undefined` for
 * anything that is not a non-empty string after sanitization, so callers can use
 * a plain truthiness check to decide whether there is an excerpt to show.
 *
 * Guarantees on the returned value:
 *   1. contains no ANSI/CSI/OSC escape sequence;
 *   2. contains no control character other than `\n` -- no `\r`, no `\t`, no NUL,
 *      no DEL, no C1;
 *   3. has no run of more than one blank line, and no trailing spaces per line;
 *   4. is at most {@link MAX_BUILD_FAILURE_REASON_CHARS} characters, ending in
 *      {@link BUILD_FAILURE_TRUNCATION_MARKER} when it was cut;
 *   5. is trimmed (no leading/trailing whitespace).
 *
 * NOT done, deliberately: HTML escaping. `<`, `>`, `&`, `"` are legitimate
 * build-log characters (`Cannot find module "foo"`, `a < b`) and are preserved
 * verbatim -- escaping belongs to the renderer, and every current consumer (React
 * text nodes, JSON) escapes correctly. A raw `</script>` in the excerpt is
 * therefore preserved AS TEXT, and is safe precisely because it is never
 * interpolated into an HTML or script context.
 */
export function sanitizeBuildFailureReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0) return undefined;

  // Bound the work before any regex touches it.
  let text = raw.length > MAX_RAW_INPUT_CHARS ? raw.slice(0, MAX_RAW_INPUT_CHARS) : raw;

  // 1. Terminal escape sequences (must precede the control-character sweep).
  for (const pattern of ESCAPE_SEQUENCE_PATTERNS) text = text.replace(pattern, '');

  // 2. Line endings: CRLF -> LF, then drop any stray CR (a bare CR would otherwise
  //    overwrite the line in a terminal / render as an invisible artifact).
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '');

  // 3. Tabs -> a single space (preserves word separation without terminal-width
  //    surprises); then remove every remaining disallowed control character.
  text = stripControlChars(text.replace(/\t/g, ' '));

  // 4. Trim trailing whitespace per line, then collapse blank-line runs to one.
  text = text
    .split('\n')
    .map((line) => line.replace(/ +$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length === 0) return undefined;

  // 5. Hard truncate. The marker REPLACES the tail so the total never exceeds the
  //    cap (a marker appended past the cap would defeat the point).
  if (text.length > MAX_BUILD_FAILURE_REASON_CHARS) {
    const keep = MAX_BUILD_FAILURE_REASON_CHARS - BUILD_FAILURE_TRUNCATION_MARKER.length;
    text = text.slice(0, keep).trimEnd() + BUILD_FAILURE_TRUNCATION_MARKER;
  }

  return text;
}

/**
 * The exact `deploy_detail` string stored for a NON-successful build callback.
 *
 * DARK-SAFE CONTRACT: with no excerpt this returns `Build <status>` -- BYTE-
 * IDENTICAL to what shipped before `failureReason` existed -- so an old pipeline
 * (which never sends the field) against new civitai-web produces exactly today's
 * value. The excerpt is appended after a blank line only when one survives
 * sanitization.
 *
 * Pure + exported so both the handler and its tests derive the string the same way.
 */
export function buildFailureDeployDetail(status: string | undefined, reason: unknown): string {
  const prefix = `Build ${String(status ?? 'failed').slice(0, 60)}`;
  const excerpt = sanitizeBuildFailureReason(reason);
  return excerpt ? `${prefix}\n\n${excerpt}` : prefix;
}
