import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PatternGuard from '~/server/services/blocks/settings-pattern-guard';

// The REAL guard, wrapped so the calls can be counted: every verdict is still recheck's own.
vi.mock('~/server/services/blocks/settings-pattern-guard', async (importOriginal) => {
  const real = await importOriginal<typeof PatternGuard>();
  return { ...real, isPatternRedosVulnerable: vi.fn(real.isPatternRedosVulnerable) };
});

import { BlockManifestValidator } from '../block-manifest-validator.service';
import { isPatternRedosVulnerable } from '~/server/services/blocks/settings-pattern-guard';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The submit-time ReDoS analysis of storage collection-schema patterns: each analysis blocks
 * the event loop (hundreds of ms for a long pattern), so a pattern declared at several places
 * is analysed once, and with the flags the store compiles it with ("u").
 */

const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};
const manifest = (collections: Record<string, unknown>) => ({
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
  iframe: {
    src: 'https://blocks.civitai.com/test',
    minHeight: 200,
    maxHeight: null,
    resizable: true,
    sandbox: 'allow-scripts',
  },
  scopes: ['models:read:self', 'apps:storage'],
  page: { path: '/', title: 'Test Block' },
  storage: { collections },
});
const field = (pattern: string) => ({ type: 'string', pattern, maxLength: 40 });
const VULNERABLE =
  'is vulnerable to ReDoS (catastrophic backtracking) — remove nested or overlapping unbounded quantifiers (e.g. "(a+)+") or simplify the expression';

describe('collection-schema ReDoS gate — one analysis per distinct pattern', () => {
  // A block body, not an arrow expression: a function returned from beforeEach is run as a
  // teardown, and mockClear returns the mock, which would then call the guard with no pattern.
  beforeEach(() => {
    vi.mocked(isPatternRedosVulnerable).mockClear();
  });

  it('analyses a repeated pattern once, with "u", and still reports every place it appears', async () => {
    const m = manifest({
      notes: {
        visibility: 'private',
        schema: {
          properties: {
            a: field('^(a+)+$'),
            b: field('^[a-z]{1,8}$'),
            c: { type: 'array', items: field('^(a+)+$') },
          },
        },
      },
      drafts: {
        visibility: 'private',
        schema: { properties: { a: field('^(a+)+$'), b: field('^[a-z]{1,8}$') } },
      },
    });
    expect(await BlockManifestValidator.validateSubmission(m, APP_CTX)).toEqual({
      valid: false,
      errors: [
        `storage.collections.notes.schema.properties.a.pattern ${VULNERABLE}`,
        `storage.collections.notes.schema.properties.c.items.pattern ${VULNERABLE}`,
        `storage.collections.drafts.schema.properties.a.pattern ${VULNERABLE}`,
      ],
    });
    const calls = vi.mocked(isPatternRedosVulnerable).mock.calls;
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => JSON.stringify(c)))).toEqual(
      new Set([JSON.stringify(['^(a+)+$', 'u']), JSON.stringify(['^[a-z]{1,8}$', 'u'])])
    );
  });

  it('runs no analysis when the manifest is over the pattern cap', async () => {
    const many = (prefix: string, n: number) => ({
      visibility: 'private',
      schema: {
        properties: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`p${i}`, field(`^${prefix}${i}`)])
        ),
      },
    });
    const result = await BlockManifestValidator.validateSubmission(
      manifest({ c0: many('a', 16), c1: many('b', 16), c2: many('c', 3) }),
      APP_CTX
    );
    expect(result.valid).toBe(false);
    expect(vi.mocked(isPatternRedosVulnerable)).not.toHaveBeenCalled();
  });
});
