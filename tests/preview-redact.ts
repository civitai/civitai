/**
 * Keep session credentials out of the preview smoke log.
 *
 * The smoke suite authenticates with a minted session cookie (preview-auth.setup.ts),
 * and Playwright's own error output prints it: when an APIRequestContext call or a
 * `route.fetch()` fails, the error carries a "Call log" that lists every REQUEST
 * HEADER, `cookie:` included (playwright-core `server/fetch.js`). The list reporter
 * prints that error verbatim, so a single failing request put a live session token in
 * the CI log. Nothing in this repo ever called `console.log(token)` — the print is the
 * test runner's, which is why a lint over our own source could not have caught it.
 *
 * So the fix is at the OUTPUT boundary, not at a call site: `installOutputRedaction()`
 * wraps `process.stdout.write` / `process.stderr.write` of whatever process loads
 * playwright.preview.config.ts. That covers the runner process, where every reporter
 * writes — including reporters chosen on the command line (`--reporter=list,json`),
 * which REPLACE the config's `reporter` list and so would bypass a redacting reporter.
 *
 * Out of scope (not stdout/stderr): the JSON report file, the HTML report, traces and
 * `error-context.md` on disk. They stay wherever the runner writes them.
 *
 * A redacted value keeps its first 4 characters and its length, e.g. `eyJh***(len=412)`,
 * enough to tell two tokens apart in a log without making either usable.
 */

const MASK_MARK = '***(len=';

export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}${MASK_MARK}${value.length})`;
}

// Characters a cookie value / bearer token is made of. `*` is deliberately absent, so a
// value that has already been masked (`eyJh***(len=…)`) leaves only its 4-char prefix
// for these patterns, which is below their minimum length: redaction is idempotent.
const VALUE = '[A-Za-z0-9_\\-.~%+/=]{9,}';

/**
 * Cookie (or query-string) assignments whose NAME says it holds a credential:
 * `__Secure-civitai-token=…`, `next-auth.session-token=…`, `?token=…`.
 */
const NAMED_CREDENTIAL = new RegExp(
  `((?:^|[\\s;,?&"'])(?:__Secure-|__Host-)?[A-Za-z0-9_.-]*(?:token|session|secret)[A-Za-z0-9_.-]*=)(${VALUE})`,
  'gi'
);

/** `authorization: Bearer …` and friends. */
const BEARER = new RegExp(`(\\bbearer\\s+)(${VALUE})`, 'gi');

/**
 * A compact JWT / JWE wherever it appears: a base64url JSON header (`eyJ…`) followed by
 * dot-separated segments. A JWE with `alg: dir` has an EMPTY second segment
 * (`header..iv.ciphertext.tag`), hence `*` not `+` inside the segments.
 */
const COMPACT_JOSE = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)+/g;

/** Exact values of secrets the harness holds in its environment. */
const SECRET_ENV_VARS = ['NEXTAUTH_SECRET'];

export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) out = out.split(secret).join(maskSecret(secret));
  }
  out = out.replace(COMPACT_JOSE, (m) => maskSecret(m));
  out = out.replace(
    NAMED_CREDENTIAL,
    (_m, prefix: string, value: string) => prefix + maskSecret(value)
  );
  out = out.replace(BEARER, (_m, prefix: string, value: string) => prefix + maskSecret(value));
  return out;
}

const INSTALLED = Symbol.for('civitai.preview-smoke.output-redaction');

type Write = NodeJS.WriteStream['write'];

/**
 * Redact everything written through `stream.write`. Exported for the unit test; use
 * `installOutputRedaction()` in the harness.
 *
 * The `Uint8Array` branch is live, not defensive: a test's own output is relayed from the
 * worker as a Buffer whenever the test wrote one (`process.stdout.write(buf)`), and the
 * list reporter writes that Buffer straight to stdout. Both tiers of
 * scripts/__tests__/preview-smoke-log-redaction.test.ts exercise it.
 */
export function wrapWrite(stream: Pick<NodeJS.WriteStream, 'write'>) {
  const original = stream.write.bind(stream) as unknown as (...args: unknown[]) => boolean;
  const redacting = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') return original(redactSecrets(chunk), ...rest);
    if (chunk instanceof Uint8Array) {
      const asText = Buffer.from(chunk).toString('utf8');
      const redacted = redactSecrets(asText);
      if (redacted !== asText) {
        // The chunk is now a string, so an explicit encoding argument no longer applies.
        const tail = typeof rest[0] === 'string' ? rest.slice(1) : rest;
        return original(redacted, ...tail);
      }
    }
    return original(chunk, ...rest);
  };
  stream.write = redacting as unknown as Write;
}

/** Idempotent: a second call (the config is loaded by every worker too) is a no-op. */
export function installOutputRedaction(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  wrapWrite(process.stdout);
  wrapWrite(process.stderr);
}
