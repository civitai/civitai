import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

// `VerificationToken.identifier` is plain text (unlike the citext `User.email`), so the magic-link
// sender and the verify endpoint must derive the identifier with the SAME normalizer. They diverged
// once — #4432 moved the sender to `normalizeEmailAddress`, which preserves local-part case, while
// verify kept `.toLowerCase()` — and every address with a capital letter before the `@` was locked
// out of email login entirely, on every retry, until the two were realigned.
//
// Source-text assertions rather than handler calls: the divergence is which function each route
// picks, and neither route can be imported here without standing up SvelteKit's virtual modules.

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const SEND = read('../../../../routes/login/+page.server.ts');
const VERIFY = read('../../../../routes/login/email/verify/+server.ts');

describe('magic-link identifier normalizer parity', () => {
  it('the sender normalizes the address it stores', () => {
    expect(SEND).toMatch(/const email = normalizeEmailAddress\(/);
  });

  it('verify normalizes with the same function, and never lowercases the address itself', () => {
    expect(VERIFY).toMatch(/normalizeEmailAddress\(/);
    expect(VERIFY).not.toMatch(/searchParams\.get\('email'\)[^;]*toLowerCase/);
  });
});
