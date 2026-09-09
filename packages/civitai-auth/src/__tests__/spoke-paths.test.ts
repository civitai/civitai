import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SPOKE_AUTHORIZE_PATH, SPOKE_CALLBACK_PATH } from '../index';

// Both ends of the first-party login round trip are strings two different apps must agree on:
//   SPOKE_AUTHORIZE_PATH — the main app WRITES it (buildHubLoginUrl), the hub MATCHES on it to decide a
//                          cross-domain hand-off (establishSession).
//   SPOKE_CALLBACK_PATH  — the spoke serves it, the hub pins redirect_uri to it.
// A drift in the first one fails SILENTLY: the hub stops handing off and writes its own `.civitai.com`
// session, which is the cross-domain account-switch bug returning with no error. Pin the values, and pin
// that nobody has re-introduced a hardcoded copy alongside them.

const REPO = resolve(__dirname, '../../../..');

describe('first-party spoke path contract', () => {
  it('has the values both apps are built around', () => {
    expect(SPOKE_AUTHORIZE_PATH).toBe('/api/auth/authorize');
    expect(SPOKE_CALLBACK_PATH).toBe('/api/auth/callback');
  });

  it.each([
    ['the main app writer', 'src/utils/hub-login.ts'],
    ['the hub matcher', 'apps/auth/src/lib/server/auth/session.ts'],
  ])('%s uses the constant, not a literal', (_label, rel) => {
    // Drop comments AND import lines. Both are the reason a naive version of this guard is vacuous: the
    // import keeps the constant's NAME in the file even after every use has been replaced by a literal, and
    // the realistic regression is a template literal (`${origin}/api/auth/authorize`), not a quoted string —
    // so the path check has to be a bare substring, not `'…'`. Verified by mutating the writer back to a
    // literal and watching this fail.
    const body = readFileSync(resolve(REPO, rel), 'utf-8')
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('import ') && t !== '';
      })
      .join('\n');

    expect(body).toContain('SPOKE_AUTHORIZE_PATH');
    expect(body).not.toContain(SPOKE_AUTHORIZE_PATH);
  });
});
