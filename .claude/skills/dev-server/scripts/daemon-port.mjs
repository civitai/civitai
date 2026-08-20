/**
 * One rule, one place: what port the dev daemon lives on.
 *
 * This used to be open-coded at four sites and disagreed at two of them — cli.mjs and
 * scripts/test-unit-run.mjs read DEV_DAEMON_PORT, console.mjs hardcoded 9444, and the daemon
 * itself only ever saw `--port`. Setting DEV_DAEMON_PORT therefore pointed the client at a port
 * nothing was serving instead of relocating the daemon.
 *
 * Every one of those four now resolves the port here. A daemon a client spawns inherits that
 * client's environment, so both ends read the same variable through the same function and cannot
 * disagree. An explicit `node daemon.mjs --port <port>` still beats the environment.
 *
 * 9444 is spelled once, in this file. `dev-server-daemon-port.test.ts` fails if a second copy
 * appears.
 */

export const DEFAULT_DAEMON_PORT = 9444;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number} a valid TCP port
 * @throws {Error} if DEV_DAEMON_PORT is set to something that is not a port
 */
export function resolveDaemonPort(env = process.env) {
  const raw = env.DEV_DAEMON_PORT;
  if (raw === undefined || raw === '') return DEFAULT_DAEMON_PORT;

  // parseInt('9555abc') is 9555 and parseInt('abc') is NaN — neither is a port, and NaN would
  // otherwise reach a URL as `http://127.0.0.1:NaN` and fail somewhere far from the cause.
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`DEV_DAEMON_PORT is not a number: ${JSON.stringify(raw)}`);
  }
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) {
    throw new Error(`DEV_DAEMON_PORT is out of range 1-65535: ${JSON.stringify(raw)}`);
  }
  return port;
}
