// Shared case table for every helper that validates a same-origin return path. Each helper keeps its own
// fallback contract (`'/'`, `false`, `null`), but all of them must agree on which inputs are refused and
// on the path a legitimate input resolves to.

/** Inputs that must never come back out as a return path. `[name, input]`. */
export const UNSAFE_RETURN_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['tab right after the leading slash', '/\t/other.example'],
  ['line feed right after the leading slash', '/\n/other.example'],
  ['carriage return right after the leading slash', '/\r/other.example'],
  ['repeated tabs', '/\t\t/other.example'],
  ['repeated line feeds', '/\n\n/other.example'],
  ['tab then backslash', '/\t\\other.example'],
  ['dot segment whose normalised form is not same-origin', '/.//other.example'],
  ['parent segment whose normalised form is not same-origin', '/a/..//other.example'],
  ['encoded dot segment whose normalised form is not same-origin', '/%2e//other.example'],
  ['protocol-relative', '//other.example'],
  ['backslash after the leading slash', '/\\other.example'],
  ['backslash then slash', '/\\/other.example'],
  ['backslash later in the path', '/a\\b'],
  ['control character inside the path', '/a\tb'],
  ['NUL inside the path', '/a\u0000b'],
  ['NUL right after the leading slash', '/\u0000/other.example'],
  ['DEL inside the path', '/a\u007fb'],
  ['absolute https', 'https://other.example/x'],
  ['absolute http', 'http://other.example'],
  ['javascript: scheme', 'javascript:alert(1)'],
  ['mixed-case javascript: scheme', 'JaVaScRiPt:alert(1)'],
  ['javascript: scheme after a tab', '\tjavascript:alert(1)'],
  ['javascript: scheme after a space', ' javascript:alert(1)'],
  ['relative, no leading slash', 'other.example'],
  ['empty', ''],
];

/** Legitimate inputs and the path each must resolve to. `[name, input, expected]`. */
export const SAFE_RETURN_PATHS: ReadonlyArray<readonly [string, string, string]> = [
  ['root', '/', '/'],
  ['plain path', '/ok', '/ok'],
  ['path with query and fragment', '/a/b?c=1#d', '/a/b?c=1#d'],
  ['encoded slash stays encoded', '/a%2Fb', '/a%2Fb'],
  ['encoded tab stays encoded', '/a%09b', '/a%09b'],
  ['query that itself holds a url', '/login?returnUrl=%2Fx', '/login?returnUrl=%2Fx'],
  // Rows whose expected output differs from the input: the normalised form is what comes back.
  ['parent segment normalises', '/a/../b', '/b'],
  ['single-dot segment normalises', '/./b', '/b'],
  ['space is percent-encoded', '/a b', '/a%20b'],
];
