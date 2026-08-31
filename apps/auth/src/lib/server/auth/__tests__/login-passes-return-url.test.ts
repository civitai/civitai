import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';

// `opts.returnUrl` is the SOLE trigger for the cross-domain hand-off in establishSession. If a login route
// stops passing it, the whole fix goes inert — and every behavioural test still passes, because they all call
// establishSession directly. That is exactly how the first version of this change shipped broken.
//
// A route-level integration test would need the full SvelteKit + provider + DB stack, so this asserts the
// wiring the cheap way: every establishSession call on a LOGIN path passes a returnUrl. Being source
// assertions they cannot check semantics — only that the argument is still there, which is the part that
// silently disappears.

const ROOT = resolve(__dirname, '../../../../..'); // apps/auth
const LOGIN_ROUTES = [
  'src/routes/login/[provider]/callback/+server.ts',
  'src/routes/login/email/verify/+server.ts',
];

const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf-8');

describe('every login route hands establishSession its returnUrl', () => {
  it.each(LOGIN_ROUTES)('%s', (rel) => {
    const src = read(rel);
    const calls = src.match(/establishSession\([^)]*\)/gs) ?? [];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/returnUrl/);
  });
});

describe('no OTHER route establishes a session without one', () => {
  // A new login path that forgets the argument re-opens the bug silently. Enumerating callers here means
  // adding one shows up as a failure naming the file, rather than as a fix that quietly stops working.
  it('the set of establishSession callers is exactly the known login routes', () => {
    const callers = listRouteFiles(resolve(ROOT, 'src/routes')).filter((f) =>
      readFileSync(f, 'utf-8').includes('establishSession(')
    );
    const relative = callers.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/')).sort();

    expect(relative).toEqual([...LOGIN_ROUTES].sort());
  });
});

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.svelte')) out.push(full);
  }
  return out;
}
