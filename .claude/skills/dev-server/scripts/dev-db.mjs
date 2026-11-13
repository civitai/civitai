/**
 * A worktree's app envs use the database the primary checkout's ROOT `.env` names.
 *
 * The primary's per-app `.env` files may point elsewhere on purpose (the shared auth hub runs from
 * the primary), and a copy of one into a worktree used to carry that value along. The root `.env`
 * is the one every worktree session already layers on, so its value is the rule: no list of hosts
 * to keep up to date.
 *
 * Applied by `app-env.mjs` to every copied or kept `.env`, and by the daemon (`appDatabaseEnv`) to
 * every app it spawns in a worktree. A hand edit to the worktree's own app `.env` after the copy is
 * the only way to point a worktree app elsewhere.
 *
 * 🔴 NEVER PRINTS A VALUE. Logs and errors name keys and paths only.
 */

export const DB_KEYS = Object.freeze(['DATABASE_URL', 'DATABASE_REPLICA_URL']);

export const DEV_DB_LOG =
  'Database: DATABASE_URL / DATABASE_REPLICA_URL from this worktree (its app .env, else its root .env chain); the primary app .env is ignored for them';

export class DevDbMissingError extends Error {
  constructor(files) {
    const list = files.join(', ');
    super(
      `The primary checkout's root .env has no active DATABASE_URL, so the database lines in ${list} ` +
        'have no dev value to take. Set DATABASE_URL in the primary root .env and run again.'
    );
    this.code = 'DEV_DB_MISSING';
    this.files = files;
  }
}

// `KEY=`, `export KEY=`, and the same commented out: a commented line is one edit away from live.
const DB_LINE = /^(\s*)(#\s*)?(export\s+)?(DATABASE_URL|DATABASE_REPLICA_URL)\s*=(.*)$/;

/**
 * The raw right-hand sides (quoting kept) of the last active DATABASE_URL and DATABASE_REPLICA_URL
 * lines in a root `.env`, or null when it has no active DATABASE_URL. The apps require a replica
 * URL, so a root without one lends its DATABASE_URL.
 */
export function devDbFromEnvText(text) {
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(DB_LINE);
    if (m && !m[2]) found[m[4]] = m[5].trim();
  }
  if (!found.DATABASE_URL) return null;
  return {
    DATABASE_URL: found.DATABASE_URL,
    DATABASE_REPLICA_URL: found.DATABASE_REPLICA_URL || found.DATABASE_URL,
  };
}

/**
 * Active DB lines take `devDb`'s value in place; commented ones are dropped. A file with no DB line
 * comes back unchanged — it inherits the chain, so it never gains one. `changed` counts the lines
 * that differ, so routing an already-routed file is a no-op.
 *
 * Throws (`missing: true`) rather than guess when the file has an active DB line and `devDb` is null.
 */
export function routeEnvTextToDevDb(text, devDb) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let changed = 0;
  for (const line of lines) {
    const m = line.match(DB_LINE);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, indent, comment, exp = '', key, rhs] = m;
    if (comment) {
      changed++;
      continue;
    }
    if (!devDb) return { text, changed: 0, missing: true };
    if (rhs.trim() === devDb[key]) out.push(line);
    else {
      out.push(`${indent}${exp}${key}=${devDb[key]}`);
      changed++;
    }
  }
  return { text: changed ? out.join(eol) : text, changed, missing: false };
}

/**
 * The DB keys for an app spawned in a worktree, key by key: the worktree's own app `.env` if it sets
 * the key, else the worktree's root chain. A key neither sets is `undefined`, which `spawnEnvFor`
 * deletes — so the primary app `.env` and the daemon's own environment never fill the gap.
 *
 * A replica the worktree's app `.env` does not set follows the DATABASE_URL that was picked: an app
 * pointed at its own database by hand gets that database as its replica too, not the root's.
 */
export function appDatabaseEnv(ownAppVars, rootVars) {
  const url = 'DATABASE_URL' in ownAppVars ? ownAppVars.DATABASE_URL : rootVars.DATABASE_URL;
  const replica =
    'DATABASE_REPLICA_URL' in ownAppVars
      ? ownAppVars.DATABASE_REPLICA_URL
      : 'DATABASE_URL' in ownAppVars
      ? ownAppVars.DATABASE_URL
      : rootVars.DATABASE_REPLICA_URL;
  return { DATABASE_URL: url, DATABASE_REPLICA_URL: replica || url };
}
