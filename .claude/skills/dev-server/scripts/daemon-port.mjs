/**
 * One rule, one place: where the dev daemon lives.
 *
 * This used to be open-coded at five sites and disagreed at three of them — cli.mjs and
 * scripts/test-unit-run.mjs read DEV_DAEMON_PORT, console.mjs hardcoded 9444, the daemon itself
 * only ever saw `--port`, and .claude/hooks/check-writable.mjs baked 9444 into a regex. Setting
 * DEV_DAEMON_PORT therefore pointed the client at a port nothing was serving.
 *
 * Every one of those now resolves through this module. A daemon a client spawns inherits that
 * client's environment, so both ends read the same variable through the same function and cannot
 * disagree. An explicit `node daemon.mjs --port <port>` still beats the environment — and goes
 * through `parsePort` here too, so argv gets the same validation the environment gets.
 *
 * `9444` is spelled once in the code that DECIDES it. `dev-server-daemon-port.test.ts` walks
 * three roots — this skill, `scripts/`, `.claude/hooks` — over .mjs/.cjs/.js/.ts, and fails if a
 * second copy appears in any of them, including in a file that does not exist yet. Deliberately
 * NOT covered: prose (SKILL.md names the default, as documentation should) and test files, which
 * must pin the expected value as a literal rather than derive it from this module.
 */

import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export const DEFAULT_DAEMON_PORT = 9444;

/**
 * Parse one port value from anywhere — an env var, an argv flag.
 *
 * parseInt, which every one of these call sites used to use, reads '9555abc' as 9555 and 'abc'
 * as NaN. NaN reaches a URL as `http://127.0.0.1:NaN`, or a listen() as ERR_SOCKET_BAD_PORT, a
 * long way from the thing that was actually wrong.
 *
 * @param {string | undefined} raw
 * @param {string} source — named in the error, so the message says which input to go fix
 * @returns {number}
 */
export function parsePort(raw, source) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (!/^\d+$/.test(String(value ?? ''))) {
    throw new Error(`${source} is not a port number: ${JSON.stringify(raw)}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`${source} is out of the port range 1-65535: ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number} a valid TCP port
 * @throws {Error} if DEV_DAEMON_PORT is set to something that is not a port
 */
export function resolveDaemonPort(env = process.env) {
  const raw = env.DEV_DAEMON_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAEMON_PORT;
  return parsePort(raw, 'DEV_DAEMON_PORT');
}

/**
 * The daemon's base URL. Exported so a caller never does arithmetic on the port itself — the
 * whole decision, port included, is made here.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDaemonUrl(env = process.env) {
  return `http://127.0.0.1:${resolveDaemonPort(env)}`;
}

/**
 * Where a daemon on `port` records its pid — SCOPED BY PORT, because the file names one process.
 *
 * It used to be one shared `daemon.pid` for every daemon on the box, and the sharing is not a
 * tidiness problem, it is a correctness one. Measured on this repo before the change: with a
 * sentinel written to `daemon.pid`, `DEV_DAEMON_PORT=<free> cli.mjs status` replaced it with the
 * probe daemon's pid, and `DEV_DAEMON_PORT=<free> cli.mjs shutdown` then deleted it — so
 * `readlink -f /proc/$(cat daemon.pid)/exe`, the check SKILL.md tells people to run before
 * trusting a session, was pointed at a second daemon and then at nothing at all.
 *
 * That measurement is also why an ownership check ALONE would not have fixed it: by shutdown time
 * the probe daemon genuinely owned the shared file, so "only delete a file that names me" would
 * have deleted it exactly the same. The pid file has to stop being shared first; the ownership
 * check below is what covers what remains (a stale file, or a second daemon told to use the same
 * port explicitly).
 *
 * The DEFAULT port keeps the plain `daemon.pid` name, so the documented recipe and this repo's
 * `.gitignore` entry both keep working — only the extra daemons get a new file.
 *
 * @param {string} skillDir — the dev-server skill directory
 * @param {number} port
 * @returns {string}
 */
export function pidFileFor(skillDir, port) {
  const name = port === DEFAULT_DAEMON_PORT ? 'daemon.pid' : `daemon-${port}.pid`;
  return join(skillDir, name);
}

/**
 * The pid file for the daemon THIS environment points at — the client-side pair of
 * `resolveDaemonUrl`, so a client never does arithmetic on a port or spells a filename itself.
 *
 * @param {string} skillDir
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDaemonPidFile(skillDir, env = process.env) {
  return pidFileFor(skillDir, resolveDaemonPort(env));
}

/**
 * The pid a pid file names, or null if there isn't one to be had.
 *
 * Null for absent, unreadable, and for contents that are not a pid — a truncated write, or the
 * file having been replaced by something else. A caller acts on this, so guessing a number out of
 * garbage is how a live process gets treated as a dead one.
 *
 * @param {string} path
 * @returns {number | null}
 */
export function readPidFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

/**
 * Is this pid a process that exists right now?
 *
 * Signal 0 checks for existence without delivering anything. EPERM means the process is there and
 * belongs to somebody else — which is still ALIVE, and the answer that matters here, since the
 * whole point is not to clean up after a process that is still running. Reading EPERM as "gone" is
 * the one wrong answer that does damage.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Remove a pid file only if it names `ownerPid`.
 *
 * For a daemon removing its OWN file on the way out. A daemon that finds another pid there is
 * looking at a file it does not own — deleting it is how the last daemon to stop takes the
 * record of the one still running with it.
 *
 * @param {string} path
 * @param {number} ownerPid
 * @returns {boolean} whether the file was removed
 */
export function removePidFileIfOwned(path, ownerPid) {
  if (readPidFile(path) !== ownerPid) return false;
  return unlink(path);
}

/**
 * Remove a pid file only if the process it names is GONE.
 *
 * For a client tidying up after a daemon — it cannot know the daemon's pid, so "names me" is not a
 * question it can ask, but "is there anything behind this" is. A live pid here is not a leftover
 * and must be left alone: the pre-2026-08-21 `cli.mjs shutdown` unlinked whatever it found, which
 * on a box running a second daemon was the record of the first.
 *
 * A file that is not there, and one holding something that is not a pid, are both removed — the
 * second is a leftover in a broken state, and no process can be behind it.
 *
 * @param {string} path
 * @returns {boolean} whether the file was removed
 */
export function removeStalePidFile(path) {
  const pid = readPidFile(path);
  if (pid !== null && isPidAlive(pid)) return false;
  return unlink(path);
}

function unlink(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
