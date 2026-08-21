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
