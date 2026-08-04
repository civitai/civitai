import { describe, expect, it, vi } from 'vitest';

/**
 * `getRequestBoardDomainColor` — the resolver behind per-domain leaderboard
 * visibility (src/server/utils/server-domain.ts).
 *
 * The env stub mirrors production, where civitai.red is configured as BOTH the blue
 * and the red domain. That shape makes the plain color walk return `blue` for .red
 * and NEVER return `red` — so a board scoped to `['red']` on the back of
 * `getRequestDomainColor` would be hidden on every host rather than moved to .red.
 * These tests pin the escape hatch so that regression can't come back a third time
 * (App Blocks hit it first).
 */
vi.mock('~/env/server', () => ({
  env: {
    SERVER_DOMAIN_GREEN: 'civitai.com',
    SERVER_DOMAIN_GREEN_ALIASES: '',
    SERVER_DOMAIN_BLUE: 'civitai.red',
    SERVER_DOMAIN_BLUE_ALIASES: '',
    SERVER_DOMAIN_RED: 'civitai.red',
    SERVER_DOMAIN_RED_ALIASES: 'www.civitai.red',
  },
}));

const req = (host?: string) => ({ headers: { host } });

describe('getRequestBoardDomainColor', () => {
  it('resolves red for a red-capable host, where the color walk resolves blue', async () => {
    const { getRequestBoardDomainColor, getRequestDomainColor } = await import('../server-domain');

    // The bug this guards: same host, two answers.
    expect(getRequestDomainColor(req('civitai.red'))).toBe('blue');
    expect(getRequestBoardDomainColor(req('civitai.red'))).toBe('red');
  });

  it('resolves red for red aliases too', async () => {
    const { getRequestBoardDomainColor } = await import('../server-domain');
    expect(getRequestBoardDomainColor(req('www.civitai.red'))).toBe('red');
  });

  it('resolves red for a red-capable host regardless of case', async () => {
    const { getRequestBoardDomainColor } = await import('../server-domain');
    expect(getRequestBoardDomainColor(req('CIVITAI.RED'))).toBe('red');
  });

  it('leaves a non-red host on its walked color', async () => {
    const { getRequestBoardDomainColor } = await import('../server-domain');
    expect(getRequestBoardDomainColor(req('civitai.com'))).toBe('green');
  });

  it('fails closed on an unknown or missing host', async () => {
    const { getRequestBoardDomainColor } = await import('../server-domain');
    expect(getRequestBoardDomainColor(req('example.com'))).toBeUndefined();
    expect(getRequestBoardDomainColor(req(undefined))).toBeUndefined();
    expect(getRequestBoardDomainColor(req(''))).toBeUndefined();
  });

  it('never returns red for a host that is not red-capable', async () => {
    const { getRequestBoardDomainColor } = await import('../server-domain');
    for (const host of ['civitai.com', 'example.com', 'localhost:3000']) {
      expect(getRequestBoardDomainColor(req(host))).not.toBe('red');
    }
  });
});
