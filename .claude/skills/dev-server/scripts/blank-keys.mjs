/**
 * Keys a worktree never carries a value for: the storage credentials for the restricted bucket. Dev
 * trees have no business writing there, and every reader treats an empty value as "not configured".
 *
 * Applied by `app-env.mjs` to every copied or kept `.env`, and by the daemon to every app it spawns
 * in a worktree.
 */

export const BLANKED_KEY = /^CSAM_[A-Z0-9_]*$/;

// Active and commented-out lines alike: a commented line is one edit away from live.
const BLANKED_LINE = /^(\s*)(#\s*)?(export\s+)?(CSAM_[A-Z0-9_]*)\s*=(.*)$/;

/** Every blanked key keeps its line with an empty value. `changed` counts lines that had one. */
export function blankEnvText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let changed = 0;
  const lines = text.split(/\r?\n/).map((line) => {
    const m = line.match(BLANKED_LINE);
    if (!m || m[5].trim() === '') return line;
    changed++;
    const [, indent, comment = '', exp = '', key] = m;
    return `${indent}${comment}${exp}${key}=`;
  });
  return { text: changed ? lines.join(eol) : text, changed };
}

/** Sets every blanked key present in `env` to ''. */
export function blankKeys(env) {
  for (const key of Object.keys(env)) if (BLANKED_KEY.test(key)) env[key] = '';
  return env;
}
