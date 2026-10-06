import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard is where the access gate sends a denied user (`/?denied=<path>`). Once the grant
 * exists, a refresh must open the page — not keep saying "denied" — and the return path must never
 * leave the app.
 */

// The page's actions reach the database at module scope; `load` never does.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { applyGrants } = await import('$lib/server/access');
const { load } = await import('../+page.server');

const MOD = { id: 7, roles: ['moderator:cm-high'] };
// `load` is synchronous, so its redirect is a THROW; wrapped so both outcomes arrive as a promise.
const run = async (qs: string, user: unknown = MOD) =>
  (load as unknown as (e: unknown) => { returnTo: string | null })({
    url: new URL(`https://moderator.example/${qs}`),
    locals: { user },
  });

beforeEach(() => applyGrants({}));

describe('dashboard ?denied=', () => {
  it('without the grant: stays, and offers the validated path back', async () => {
    const out = await run('?denied=%2Fdecisions%3Fstate%3Dall');
    expect(out.returnTo).toBe('/decisions?state=all');
  });

  it('once granted: redirects straight to the page that was asked for', async () => {
    applyGrants({ '/decisions': ['moderator:cm-high'] });
    await expect(run('?denied=%2Fdecisions%3Fstate%3Dall')).rejects.toMatchObject({
      status: 303,
      location: '/decisions?state=all',
    });
  });

  it.each([
    ['//evil.example/decisions'],
    ['https://evil.example/decisions'],
    ['javascript:alert(1)'],
    ['/.//evil.example/decisions'],
  ])('never redirects to or links %s, even for a user who can open everything', async (raw) => {
    const out = await run(`?denied=${encodeURIComponent(raw)}`, {
      id: 1,
      roles: ['moderator:admin'],
    });
    expect(out.returnTo).toBeNull();
  });

  it('a return path to the dashboard itself does not redirect, so nested ?denied= cannot chain', async () => {
    const out = await run(`?denied=${encodeURIComponent('/?denied=/decisions')}`);
    expect(out.returnTo).toBe('/?denied=/decisions');
  });

  it('no ?denied= is no return path', async () => {
    expect((await run('')).returnTo).toBeNull();
  });
});
