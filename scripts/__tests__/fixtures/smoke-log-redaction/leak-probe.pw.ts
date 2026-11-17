import { test } from '@playwright/test';

/**
 * Leak probe for scripts/__tests__/preview-smoke-log-redaction.test.ts. Not part of any
 * suite: only the two configs beside it match `*.pw.ts`.
 *
 * It reproduces the real leak path — a failing APIRequestContext call whose error
 * "Call log" lists the request headers, cookie included — plus the two direct prints
 * a harness could add (a console line and an error message). The credential is a
 * random fake the vitest side generates and passes in `LEAK_PROBE_FAKE`.
 */
const FAKE = process.env.LEAK_PROBE_FAKE ?? '';

test('leak probe', async ({ request }) => {
  if (!FAKE) throw new Error('LEAK_PROBE_FAKE is not set');
  // eslint-disable-next-line no-console
  console.log(`probe-console __Secure-civitai-token=${FAKE}`);
  // eslint-disable-next-line no-console
  console.log(`probe-secret ${process.env.NEXTAUTH_SECRET ?? ''}`);
  // A Buffer write: relayed from the worker as a Buffer and written to stdout as one by
  // the list reporter, so it reaches the redactor's Uint8Array branch, not its string one.
  process.stdout.write(
    Buffer.from(`probe-buffer __Secure-civitai-token=${process.env.LEAK_PROBE_FAKE_BUF ?? ''}\n`)
  );
  // Port 9 (discard) on loopback: refused immediately, so the request fails fast and
  // Playwright attaches its call log (method, URL, every request header) to the error.
  await request.get('http://127.0.0.1:9/probe', {
    headers: { cookie: `__Secure-civitai-token=${FAKE}; probe=1` },
    timeout: 10_000,
  });
});
