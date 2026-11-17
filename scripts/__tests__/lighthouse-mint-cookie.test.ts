import { spawnSync } from 'node:child_process';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs tests/lighthouse-mint-cookie.cjs exactly as the Lighthouse task does (plain `node`, in a
 * cwd holding lighthouserc.json), then decrypts the minted cookie and reads its claims back.
 */

const SCRIPT = resolve(__dirname, '../../tests/lighthouse-mint-cookie.cjs');
const SECRET = 'test-only-nextauth-secret-not-real';
const COOKIE_NAME = '__Secure-civitai-token';

function decryptJWE(jwe: string, secret: string): Record<string, unknown> {
  const [header, encryptedKey, iv, ciphertext, tag] = jwe.split('.');
  expect(encryptedKey).toBe(''); // `dir` alg: no wrapped key
  const key = Buffer.from(
    hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32)
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(header, 'ascii'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

describe('lighthouse-mint-cookie.cjs', () => {
  let dir: string;
  let claims: Record<string, unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lh-mint-cookie-'));
    writeFileSync(
      join(dir, 'lighthouserc.json'),
      JSON.stringify({ ci: { collect: { numberOfRuns: 1 } } })
    );
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NEXTAUTH_SECRET: SECRET,
        BASE_URL: 'https://pr-1.example.test',
      },
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);

    const runtime = JSON.parse(readFileSync(join(dir, 'lighthouserc.runtime.json'), 'utf8'));
    const cookieHeader: string = JSON.parse(runtime.ci.collect.settings.extraHeaders).Cookie;
    expect(cookieHeader.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    claims = decryptJWE(cookieHeader.slice(COOKIE_NAME.length + 1), SECRET);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('mints a session that expires 2 hours (7200s) after it is issued', () => {
    expect(typeof claims.iat).toBe('number');
    expect((claims.exp as number) - (claims.iat as number)).toBe(7200);
  });

  it('issues the session at the current time', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Math.abs((claims.iat as number) - nowSec)).toBeLessThan(120);
  });
});
