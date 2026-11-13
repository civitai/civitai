import { request } from 'http';

/**
 * A `fetch`-shaped client for the dev-server daemon, built on `http.request`.
 *
 * Not `fetch`: on Node 24 for Windows, `process.exit` soon after back-to-back `fetch` calls dies on a
 * libuv assertion (UV_HANDLE_CLOSING, 0xC0000409) instead of exiting. The waiters poll a run's state
 * and its logs back to back and then exit, so they reported that code in place of the verdict.
 *
 * The timeout replaces undici's 300s headers/body timeouts, which `fetch` applied implicitly; without
 * one, a daemon that accepts and never answers hangs its caller forever.
 */
export const DAEMON_TIMEOUT_MS = 300_000;

export function daemonFetch(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = DAEMON_TIMEOUT_MS } = {}
) {
  return new Promise((done, fail) => {
    const req = request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('error', fail);
      res.on('end', () =>
        done({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(text),
        })
      );
    });
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`daemon did not answer within ${timeoutMs / 1000}s`))
    );
    req.on('error', fail);
    req.end(body);
  });
}
