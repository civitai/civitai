// Flag parsing for query.mjs. Its own module so a test can import it — query.mjs runs the CLI on import.

// The flags that carry no value; each is read as `=== 'true'` by the CLI. Any other flag must be given
// one, so a missing or `--`-prefixed value is an error rather than the string 'true'.
export const BOOLEAN_FLAGS = new Set(['skip-disabled', 'pro-compat', 'apply']);

/**
 * 🔴 A value-taking flag whose value was missing or started with `--` used to become the STRING 'true',
 * which is worse than a boolean here: it is a plausible value. `--path --json` filtered on the literal
 * "true", matched nothing, and reported an empty result rather than an error.
 *
 * Throws rather than exiting, so the failure is observable to a test and to any future caller.
 */
export function parseFlags(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    // `--key=value` first, so a value that legitimately starts with `--` is still expressible. An empty
    // right-hand side is rejected here too — this is the form the error below sends people to, so it is
    // the last place that should have a hole in it.
    const eq = arg.indexOf('=');
    if (eq > 2) {
      const eqKey = arg.slice(2, eq);
      const eqValue = arg.slice(eq + 1);
      if (eqValue === '') throw new Error(`--${eqKey}= was given an empty value.`);
      flags[eqKey] = eqValue;
      continue;
    }

    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      // `--apply true` worked before and still does: an explicit true/false is consumed rather than
      // left to become a positional, which would shift `positional[1]` on the commands that take one.
      const spelled = args[i + 1];
      if (spelled === 'true' || spelled === 'false') {
        flags[key] = spelled;
        i++;
      } else {
        flags[key] = 'true';
      }
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
    flags[key] = next;
    i++;
  }

  return { flags, positional };
}
