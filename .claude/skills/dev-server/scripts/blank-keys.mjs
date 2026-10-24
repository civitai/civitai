/**
 * Keys a worktree never carries a value for: the storage credentials for the restricted bucket. Dev
 * trees have no business writing there, and every reader treats an empty value as "not configured".
 *
 * Applied by `app-env.mjs` to every copied or kept `.env`, and by the daemon to every process it
 * spawns in a worktree: the main app and the apps.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// What `next dev` and `vite dev` (mode development) each read from their own directory. Both let a
// key already in process.env win, an empty one included, so the daemon empties every blanked key
// these files name rather than only the ones its own chain saw.
export const DEV_ENV_FILES = Object.freeze([
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
]);

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

/** The blanked keys any of `dir`'s DEV_ENV_FILES names, set or commented out. */
export function blankedKeyNames(dir) {
  const names = new Set();
  for (const file of DEV_ENV_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(BLANKED_LINE);
      if (m) names.add(m[4]);
    }
  }
  return [...names];
}

/** Sets every blanked key present in `env`, and each of `names`, to ''. */
export function blankKeys(env, names = []) {
  for (const key of [...Object.keys(env), ...names]) if (BLANKED_KEY.test(key)) env[key] = '';
  return env;
}
