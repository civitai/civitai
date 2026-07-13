import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BLOCK_SCOPE_TO_OAUTH_BIT } from '../block-scope.constants';

/**
 * Drift guard: the canonical published manifest schema at
 * `public/schemas/app-block/v1.json` declares `scopes.items.enum` — the list of
 * scopes a block manifest may request. That enum MUST equal the KEYS of
 * `BLOCK_SCOPE_TO_OAUTH_BIT` (the authoritative runtime scope registry) EXACTLY,
 * in the same order. The schema is what the `civitai` CLI's vendored copy +
 * editor validation compare against; the registry is what the server-side
 * middleware / mint / validator reference. If a scope is added/removed in ONE
 * place only, this fails loudly so the canonical schema and the runtime registry
 * can never silently diverge (mirrors the MARKETPLACE_CATEGORIES drift guard).
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

describe('app-block v1 schema ⇄ BLOCK_SCOPE_TO_OAUTH_BIT drift guard', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    properties?: { scopes?: { items?: { enum?: unknown } } };
  };

  it('declares scopes.items.enum as a string array', () => {
    const enumVal = schema.properties?.scopes?.items?.enum;
    expect(Array.isArray(enumVal)).toBe(true);
    expect((enumVal as unknown[]).every((s) => typeof s === 'string')).toBe(true);
  });

  it('scopes enum equals the registry keys exactly (order included)', () => {
    const schemaEnum = schema.properties?.scopes?.items?.enum as string[];
    expect(schemaEnum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });

  it('includes the two new collections scopes', () => {
    const schemaEnum = schema.properties?.scopes?.items?.enum as string[];
    expect(schemaEnum).toContain('collections:read:self');
    expect(schemaEnum).toContain('collections:write:self');
  });
});
