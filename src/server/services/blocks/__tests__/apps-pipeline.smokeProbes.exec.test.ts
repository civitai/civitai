import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildApplyReviewScript,
  buildApplyScript,
} from '~/server/services/blocks/apps-pipeline.service';

/**
 * RUNS each apply-Job script's smoke probes with a REAL curl against a local HTTP server that
 * stands in for the smoke pod. Only kubectl and the publish step are stubbed; the probes'
 * target, `http://${POD_IP}:8080`, is rewritten to the server's address. The leak check still
 * looks for `:8080`, so a leaking Location here is a relative one that resolves on the same
 * server (`/leak:8080/`), the same shape as production: the redirect is followed to a 200
 * text/html page and only the Location gives it away.
 *
 * The large-body cases pin that a `GET /` body past the pipe buffer (~64 KB) neither ends the
 * script nor changes any check's verdict.
 *
 * Unix only: the server runs in this process and the script under the system bash and curl.
 */

const NS = 'civitai-apps';
const SHA = 'b'.repeat(40);
const SLUG = 'smoke-probe-app';
const TARGET = 'http://${POD_IP}:8080';

const KUBECTL_STUB = `#!/usr/bin/env bash
echo "kubectl $*" >> "$CALL_LOG"
case " $* " in
  *" get "*jsonpath*) echo "10.0.0.7" ;;
esac
exit 0
`;
const PUBLISH_STUB = `#!/usr/bin/env bash
echo "publish ran"
`;

type Route = { status: number; headers?: Record<string, string>; body?: string };
let routes: Record<string, Route> = {};
let server: Server;
let base = '';

const html = (bytes: number) => {
  const head = '<!doctype html><html><body>';
  const tail = '</body></html>\n';
  return head + 'x'.repeat(Math.max(0, bytes - head.length - tail.length)) + tail;
};
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status, route.headers ?? {});
    res.end(route.body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SCRIPTS = [
  {
    name: 'production apply script',
    label: 'smoke test',
    pod: `smoke-${SLUG}-bbbbbbbb`,
    build: () => buildApplyScript(NS, { perAppObjects: false }),
  },
  {
    name: 'review apply script (shared server)',
    label: 'review smoke test',
    pod: `smoke-review-${'b'.repeat(16)}`,
    build: () => buildApplyReviewScript(NS, { sharedServer: true }),
  },
] as const;

/** Runs the script asynchronously: the server answering curl lives on this event loop. */
async function runScript(build: () => string) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-probes-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const templates = join(dir, 'templates');
  const tmp = join(dir, 'tmp');
  mkdirSync(bin);
  mkdirSync(templates);
  mkdirSync(tmp);
  writeFileSync(join(bin, 'kubectl'), KUBECTL_STUB);
  chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(join(templates, 'publish.sh'), PUBLISH_STUB);

  const script = build();
  // Both probes (healthz and /) must target the smoke pod, or the rewrite tests nothing.
  expect(script.split(TARGET).length - 1).toBe(2);
  const local = script.replaceAll(TARGET, base).replaceAll('/templates/', `${templates}/`);
  const callLog = join(dir, 'calls.log');
  writeFileSync(callLog, '');
  const scriptPath = join(dir, 'apply.sh');
  writeFileSync(scriptPath, local);

  const child = spawn('bash', [scriptPath], {
    env: {
      PATH: [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
      TMPDIR: tmp,
      CALL_LOG: callLog,
      SLUG,
      SHA,
      REVIEW_HOST_SHA: SHA.slice(0, 16),
      IMAGE: `ghcr.io/civitai/app-block-${SLUG}:${SHA}`,
      PUBLISH_REQUEST_ID: 'pubreq_test',
      APP_BLOCK_ID: 'apb_test',
      APPS_DOMAIN: 'example.test',
    } as unknown as NodeJS.ProcessEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  return { status, stdout, stderr, calls, leftovers: readdirSync(tmp) };
}

describe.skipIf(process.platform === 'win32').each(SCRIPTS)(
  '$name smoke probes',
  ({ label, pod, build }) => {
    const healthy = { '/healthz': { status: 200, body: 'ok' } };

    it('passes a 200 text/html page with a body far past the pipe buffer (~444 KB)', async () => {
      routes = { ...healthy, '/': { status: 200, headers: HTML, body: html(444_000) } };
      const r = await runScript(build);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain(`${label}: PASSED`);
      expect(r.stdout).toContain('publish ran');
      expect(r.status).toBe(0);
      // The headers file is removed by the cleanup trap.
      expect(r.leftovers).toEqual([]);
      // The pod name is cut without a pipe and still carries the short sha.
      expect(r.calls.some((c) => c.startsWith(`kubectl -n ${NS} run ${pod} `))).toBe(true);
    });

    it('passes a large page reached through one clean redirect', async () => {
      routes = {
        ...healthy,
        '/': { status: 302, headers: { Location: '/app/' } },
        '/app/': { status: 200, headers: HTML, body: html(300_000) },
      };
      const r = await runScript(build);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });

    it('passes a small page', async () => {
      routes = { ...healthy, '/': { status: 200, headers: HTML, body: html(791) } };
      const r = await runScript(build);
      expect(r.stdout).toContain(`${label}: PASSED`);
      expect(r.status).toBe(0);
    });

    it('fails a non-html root with its Content-Type message', async () => {
      routes = {
        ...healthy,
        '/': { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
      };
      const r = await runScript(build);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `${label}: GET / Content-Type was 'application/json' (expected text/html)`
      );
      expect(r.stdout).not.toContain('publish ran');
    });

    it('fails a redirect whose Location leaks :8080, naming the Location', async () => {
      routes = {
        ...healthy,
        '/': { status: 301, headers: { Location: '/leak:8080/' } },
        '/leak:8080/': { status: 200, headers: HTML, body: html(200_000) },
      };
      const r = await runScript(build);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${label}: redirect Location leaks the in-pod port`);
      expect(r.stderr).toContain('  Location: /leak:8080/\n');
      expect(r.stdout).not.toContain('publish ran');
    });

    it('fails a non-200 /healthz with its message', async () => {
      routes = {
        '/healthz': { status: 503, body: 'down' },
        '/': { status: 200, headers: HTML, body: html(791) },
      };
      const r = await runScript(build);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${label}: GET /healthz returned 503 (expected 200)`);
    });

    it('fails a non-200 root with its final-status message', async () => {
      routes = { ...healthy, '/': { status: 500, headers: HTML, body: html(100_000) } };
      const r = await runScript(build);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${label}: GET / final status 500 (expected 200)`);
    });

    it('fails a root that needs more than one redirect', async () => {
      routes = {
        ...healthy,
        '/': { status: 302, headers: { Location: '/a' } },
        '/a': { status: 302, headers: { Location: '/b' } },
        '/b': { status: 200, headers: HTML, body: html(791) },
      };
      const r = await runScript(build);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${label}: GET / final status 302 (expected 200)`);
    });
  }
);
