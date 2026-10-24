// Flag parsing for metabase.mjs. Its own module so a test can import it — metabase.mjs runs the CLI on
// import and exits when its credentials are unset.

// The flags that carry no value. Everything else must be given one, and this list is what lets a missing
// value be an error rather than a silent `true`.
//
// `json` is here because the CLI's own usage text advertises `--json` as a common option. Nothing reads it
// — it was silently ignored before and still is — but making the documented form exit 1 would be a
// regression introduced by the fix rather than by the bug.
export const BOOLEAN_FLAGS = new Set(['required', 'json']);

/**
 * 🔴 A value-taking flag whose value is missing, empty, or starts with `--` used to become boolean `true`,
 * and every guard downstream tests truthiness — so `create-question --query` with a swallowed value posted
 * `native: { query: true }`, which the API accepted and stored as a card with no query on it. It opened
 * blank, which reads as a permissions problem; two people nearly shipped a production DDL over it. SQL that
 * opens with a `--` comment line hits this with nothing wrong at the call site.
 *
 * Throws rather than exiting, so the failure is observable to a test and to any future caller.
 */
export function parseOpts(args, { startIndex = 1 } = {}) {
  const opts = {};
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    // `--key=value` first, so a value that legitimately starts with `--` is still expressible. An empty
    // right-hand side is rejected here too — this is the form the error below sends people to, so it is
    // the last place that should have a hole in it.
    const eq = arg.indexOf('=');
    if (eq > 2) {
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      if (value === '') throw new Error(`--${key}= was given an empty value.`);
      opts[key] = value;
      continue;
    }

    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }

    const next = args[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) {
      const got =
        next === undefined ? 'nothing followed it' : next === '' ? 'it was empty' : `got "${next}"`;
      throw new Error(
        `--${key} needs a value (${got}). A value starting with "--" is read as the next flag — ` +
          `pass it as --${key}=<value> instead.`
      );
    }
    opts[key] = next;
    i++;
  }
  return opts;
}
