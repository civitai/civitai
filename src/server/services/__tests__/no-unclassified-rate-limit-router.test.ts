import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAIL_CLOSED_RATE_LIMIT_SCOPES,
  RATE_LIMIT_FALLBACK_SCOPES,
} from '~/server/utils/rate-limit-bucket';

/**
 * LEDGER. Every router module that rate-limits a procedure must be classified, by its tRPC router
 * key, as fail-closed or fallback. The set is asserted in both directions: a new router that starts
 * rate-limiting (a new payment provider, say) fails here until someone decides which it is, and a
 * classified router that stops rate-limiting fails too, so the lists never rot into reassurance.
 * Procedures added to a fail-closed router inherit fail-closed with no further step.
 */
describe('rate-limit fail-closed ledger', () => {
  const routersDir = path.resolve(__dirname, '../../routers');
  const indexSrc = readFileSync(path.join(routersDir, 'index.ts'), 'utf8');
  const keyByFile = new Map<string, string>();
  for (const m of indexSrc.matchAll(/^\s+([a-zA-Z0-9]+): \(\) =>\s*import\('([^']+)'\)/gm)) {
    keyByFile.set(path.basename(m[2]), m[1]);
  }

  function rateLimitedRouterFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : rateLimitedRouterFiles(full);
      if (!e.name.endsWith('.ts')) return [];
      return /\brateLimit\(/.test(readFileSync(full, 'utf8')) ? [full] : [];
    });
  }

  it('can see the routers it classifies (positive control)', () => {
    expect(keyByFile.get('buzz.router')).toBe('buzz');
    expect(keyByFile.size).toBeGreaterThan(50);
  });

  it('classifies every rate-limiting router exactly once', () => {
    const files = rateLimitedRouterFiles(routersDir);
    const unmapped = files.filter((f) => !keyByFile.has(path.basename(f, '.ts')));
    expect(unmapped).toEqual([]);
    const keys = new Set(files.map((f) => keyByFile.get(path.basename(f, '.ts'))));

    const closed = new Set(FAIL_CLOSED_RATE_LIMIT_SCOPES);
    const fallback = new Set(RATE_LIMIT_FALLBACK_SCOPES);
    expect([...closed].filter((k) => fallback.has(k))).toEqual([]);
    // REST callers draw from a procedure's bucket under its router key, so they classify there too.
    expect(new Set([...closed, ...fallback])).toEqual(keys);
  });
});
