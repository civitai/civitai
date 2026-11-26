import { DETAIL_MAX_CHARS, REASON_MAX_CHARS } from './limits.ts';

/**
 * What one hook call produced.
 *
 * - `{allow: true}`: the write may proceed.
 * - `{allow: false, cause: 'denied', reason}`: the hook refused, with a reason for the user.
 * - `{allow: false, cause: <fault>, detail}`: the hook did not produce a valid answer. Every fault
 *   is the AUTHOR's (their code threw, ran out of time, memory or stack, or returned something
 *   that is not a valid result), so the caller maps it to `hook_rejected` and refunds the viewer.
 *   `detail` is for the author's logs, never for the end user.
 *
 * Runner faults (a crashed worker, an overloaded pool, a bad request) are NOT results: they are
 * non-2xx responses, which the caller maps to `hook_unavailable`.
 */
export type HookFaultCause = 'error' | 'timeout' | 'oom' | 'stack_overflow' | 'invalid_result';

export type HookResult =
  | { allow: true }
  | { allow: false; cause: 'denied'; reason: string }
  | { allow: false; cause: HookFaultCause; detail: string };

export type HookOutcome = 'allow' | 'deny' | HookFaultCause;

export function outcomeOf(result: HookResult): HookOutcome {
  if (result.allow) return 'allow';
  return result.cause === 'denied' ? 'deny' : result.cause;
}

export function fault(cause: HookFaultCause, detail: string): HookResult {
  return { allow: false, cause, detail: clip(stripControls(detail), DETAIL_MAX_CHARS) };
}

// C0 and C1 control characters, the bidi marks and embedding/override/isolate controls
// (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) that can make text render differently
// from its code points, the line and paragraph separators (U+2028, U+2029) and the BOM /
// zero-width no-break space (U+FEFF). Written as escapes so the source holds no invisible
// characters. The reason is author text shown to users.
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function stripControls(s: string): string {
  return s.replace(CONTROL_RE, '');
}

/** The first `max` UTF-16 units, without a dangling high surrogate at the cut. */
function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function clip(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

/**
 * Validate the JSON text a hook's return value serialised to (inside the VM). Exactly two shapes
 * are valid: `{"allow":true}` and `{"allow":false,"reason":<string>}` with no other keys. The
 * reason is first clipped to 2 x REASON_MAX_CHARS UTF-16 units (so a huge reason costs a bounded
 * amount of work; a high surrogate left dangling at that cut is dropped), then has control and
 * bidi characters stripped, then is TRUNCATED to REASON_MAX_CHARS code points (a cut can split a
 * multi-code-point grapheme such as a ZWJ emoji). Only the first 2 x REASON_MAX_CHARS units
 * count, so controls filling them leave less text. If what is left is empty or whitespace only,
 * the result is `invalid_result` ("deny reason is empty"): a refusal must carry something to
 * show the user. Anything else is `invalid_result`.
 */
export function validateHookReturn(json: string | undefined): HookResult {
  if (json === undefined) return fault('invalid_result', 'hook returned undefined');
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return fault('invalid_result', 'hook result is not JSON-serialisable');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fault(
      'invalid_result',
      `hook returned ${v === null ? 'null' : typeof v}, not an object`
    );
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (obj.allow === true) {
    if (keys.length !== 1) return fault('invalid_result', 'allow result has extra keys');
    return { allow: true };
  }
  if (obj.allow === false) {
    if (keys.length !== 2 || keys[0] !== 'allow' || keys[1] !== 'reason') {
      return fault('invalid_result', 'deny result must be exactly {allow:false, reason}');
    }
    if (typeof obj.reason !== 'string') {
      return fault('invalid_result', 'deny reason must be a string');
    }
    const reason = clip(
      stripControls(clipUnits(obj.reason, 2 * REASON_MAX_CHARS)),
      REASON_MAX_CHARS
    );
    if (reason.trim().length === 0) return fault('invalid_result', 'deny reason is empty');
    return { allow: false, cause: 'denied', reason };
  }
  return fault('invalid_result', '`allow` must be the boolean true or false');
}
