import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PREVIEW_SESSION_MAX_AGE_S } from '../../tests/preview-fixtures';
import { maskSecret, redactSecrets, wrapWrite } from '../../tests/preview-redact';

/**
 * Two tiers:
 *  - `redactSecrets` on literal strings, including Playwright's call-log header line shape;
 *  - END TO END: the real Playwright CLI, invoked the way the smoke task invokes it
 *    (`--reporter=list,json`, which REPLACES the config's reporters), running a probe
 *    that fails a request with a fake credential in its cookie header. Run once through
 *    the real preview config and once through a config that does not load it — the
 *    second is the control proving the probe DOES leak, so a clean first run means
 *    something.
 *
 * The fake credential is random per run and shaped like the real cookie (a `dir`/A256GCM
 * JWE), so no fixture in this repo holds a token-shaped literal.
 */

const b64url = (n: number) => randomBytes(n).toString('base64url');
const JWE_HEADER = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString(
  'base64url'
);
const fakeJwe = () => `${JWE_HEADER}..${b64url(12)}.${b64url(240)}.${b64url(16)}`;

describe('redactSecrets', () => {
  it('masks the cookie in a Playwright call-log line, keeping 4 chars + length', () => {
    const jwe = fakeJwe();
    const line = `\u001b[2m    - cookie: __Secure-civitai-token=${jwe}; civ-trpc-pool=1; ref_landing_page=%2Fgenerate\u001b[22m`;
    const out = redactSecrets(line);
    expect(out).not.toContain(jwe);
    expect(out).toBe(
      `\u001b[2m    - cookie: __Secure-civitai-token=${jwe.slice(0, 4)}***(len=${
        jwe.length
      }); civ-trpc-pool=1; ref_landing_page=%2Fgenerate\u001b[22m`
    );
  });

  it('masks a bare compact JWT/JWE anywhere in the text', () => {
    const jwe = fakeJwe();
    const jwt = `${b64url(20).replace(/^./, 'eyJ')}.${b64url(60)}.${b64url(32)}`;
    const out = redactSecrets(`token is ${jwe} and also ${jwt}`);
    expect(out).toBe(`token is ${maskSecret(jwe)} and also ${maskSecret(jwt)}`);
  });

  it('masks a non-JWT value under a credential-named cookie or query param', () => {
    const v = b64url(30);
    expect(redactSecrets(`set-cookie: next-auth.session-token=${v}; Path=/`)).toBe(
      `set-cookie: next-auth.session-token=${maskSecret(v)}; Path=/`
    );
    expect(redactSecrets(`GET /api/health?token=${v}&x=1`)).toBe(
      `GET /api/health?token=${maskSecret(v)}&x=1`
    );
  });

  it('masks a bearer token', () => {
    const v = b64url(40);
    expect(redactSecrets(`authorization: Bearer ${v}`)).toBe(
      `authorization: Bearer ${maskSecret(v)}`
    );
  });

  it('masks the exact NEXTAUTH_SECRET value', () => {
    const prev = process.env.NEXTAUTH_SECRET;
    const secret = randomBytes(16).toString('hex');
    process.env.NEXTAUTH_SECRET = secret;
    try {
      expect(redactSecrets(`secret=${secret}!`)).not.toContain(secret);
      expect(redactSecrets(`x ${secret} y`)).toBe(`x ${maskSecret(secret)} y`);
    } finally {
      if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = prev;
    }
  });

  it('is idempotent and leaves ordinary output alone', () => {
    const jwe = fakeJwe();
    const once = redactSecrets(`cookie: __Secure-civitai-token=${jwe}`);
    expect(redactSecrets(once)).toBe(once);
    const plain =
      '  ✓  68 [preview-smoke] › tests/preview-ssr-inject.spec.ts:463:7 › getLiveNow (4.0s); civ-trpc-pool=1; _ga=GA1.1.943324839.1793642672';
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe('preview smoke log, end to end through the Playwright CLI', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const fixtures = path.join(__dirname, 'fixtures/smoke-log-redaction');
  const cli = path.join(repoRoot, 'node_modules/@playwright/test/cli.js');
  const scratch = mkdtempSync(path.join(tmpdir(), 'smoke-log-redaction-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function runProbe(config: string, fake: string, secret: string, fakeBuf: string) {
    const out = path.join(scratch, path.basename(config, '.config.ts'));
    const res = spawnSync(
      process.execPath,
      [cli, 'test', '-c', path.join(fixtures, config), '--reporter=list,json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          PREVIEW_URL: 'http://127.0.0.1:9',
          NEXTAUTH_SECRET: secret,
          LEAK_PROBE_FAKE: fake,
          LEAK_PROBE_FAKE_BUF: fakeBuf,
          LEAK_PROBE_OUT: path.join(out, 'results'),
          PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(out, 'report.json'),
          FORCE_COLOR: '0',
        },
      }
    );
    return {
      status: res.status,
      log: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
      error: res.error,
    };
  }

  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  it('control: WITHOUT the preview config the probe leaks the cookie into the log', () => {
    const fake = fakeJwe();
    const secret = randomBytes(16).toString('hex');
    const fakeBuf = b64url(40);
    const { log, error } = runProbe('unredacted.config.ts', fake, secret, fakeBuf);
    expect(error).toBeUndefined();
    // The probe ran and failed the way the smoke run did.
    expect(log).toContain('1 failed');
    expect(log).toContain('cookie: __Secure-civitai-token=');
    // ...and the instrument can see a leak.
    expect(count(log, fake)).toBeGreaterThanOrEqual(2);
    expect(log).toContain(secret);
    expect(log).toContain(`probe-buffer __Secure-civitai-token=${fakeBuf}`);
  }, 120_000);

  it('through playwright.preview.config.ts no credential reaches stdout/stderr', () => {
    const fake = fakeJwe();
    const secret = randomBytes(16).toString('hex');
    const fakeBuf = b64url(40);
    const { log, error } = runProbe('redacted.config.ts', fake, secret, fakeBuf);
    expect(error).toBeUndefined();
    // Same failure, same call log — the leak PATH executed.
    expect(log).toContain('1 failed');
    expect(log).toContain('cookie: __Secure-civitai-token=');
    // Nothing usable left: not the fake, not the secret, nothing JWE-shaped.
    expect(log).not.toContain(fake);
    // The ciphertext segment alone (the header segment is a constant, so useless here).
    expect(log).not.toContain(fake.split('.')[3]);
    expect(log).not.toContain(secret);
    expect(log.match(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)+/g)).toBeNull();
    // The redacted form is what is printed instead: call log + console line.
    expect(count(log, maskSecret(fake))).toBeGreaterThanOrEqual(2);
    expect(log).toContain(maskSecret(secret));
    // The probe's Buffer write, relayed to stdout as a Buffer (wrapWrite's Uint8Array branch).
    expect(log).not.toContain(fakeBuf);
    expect(log).toContain(`probe-buffer __Secure-civitai-token=${maskSecret(fakeBuf)}`);
  }, 120_000);
});

describe('wrapWrite', () => {
  function capture() {
    const writes: unknown[] = [];
    const stream = {
      write: (chunk: unknown) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as Pick<NodeJS.WriteStream, 'write'>;
    wrapWrite(stream);
    return { stream, writes };
  }

  it('redacts a Buffer chunk and hands the stream the redacted TEXT', () => {
    const { stream, writes } = capture();
    const v = b64url(40);
    stream.write(Buffer.from(`cookie: __Secure-civitai-token=${v}\n`));
    expect(writes).toEqual([`cookie: __Secure-civitai-token=${maskSecret(v)}\n`]);
  });

  it('passes a Buffer with nothing to redact through untouched, as the same Buffer', () => {
    const { stream, writes } = capture();
    const buf = Buffer.from('  ✓  1 [preview-smoke] › ok\n');
    stream.write(buf);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(buf);
  });

  it('redacts a string chunk', () => {
    const { stream, writes } = capture();
    const jwe = fakeJwe();
    stream.write(`x ${jwe} y`);
    expect(writes).toEqual([`x ${maskSecret(jwe)} y`]);
  });
});

describe('minted preview session lifetime', () => {
  // Bounded to a smoke run, so a copy of the cookie that escapes masking expires quickly.
  it('is pinned at 2 hours', () => {
    expect(PREVIEW_SESSION_MAX_AGE_S).toBe(2 * 60 * 60);
  });

  it('is what preview-auth.setup.ts uses for BOTH the JWE exp and the cookie expiry', () => {
    const src = readFileSync(path.resolve(__dirname, '../../tests/preview-auth.setup.ts'), 'utf8');
    // No second, local lifetime constant that could drift from the pinned one.
    expect(src).not.toMatch(/MAX_AGE_S\s*=/);
    expect(src).not.toMatch(/24\s*\*\s*60\s*\*\s*60/);
    expect(
      src.match(
        /\.setExpirationTime\(Math\.floor\(Date\.now\(\) \/ 1000\) \+ PREVIEW_SESSION_MAX_AGE_S\)/g
      )
    ).toHaveLength(1);
    expect(
      src.match(/expires: Math\.floor\(Date\.now\(\) \/ 1000\) \+ PREVIEW_SESSION_MAX_AGE_S,/g)
    ).toHaveLength(1);
  });
});
