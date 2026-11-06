import { describe, expect, it } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../test/source-scan';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import {
  appRoleIdent,
  appSchemaIdent,
  isValidAppSlug,
  newBlockIdError,
  normalizeReviewPreviewId,
  reviewPreviewSchemaIdent,
  sanitizeAppSlug,
} from '~/server/utils/apps-slug';

describe('apps-slug', () => {
  describe('isValidAppSlug', () => {
    it('accepts a happy-path slug', () => {
      expect(isValidAppSlug('generate_from_model')).toBe(true);
    });

    it('accepts the shortest allowed slug (3 chars)', () => {
      expect(isValidAppSlug('abc')).toBe(true);
    });

    it('accepts the longest allowed slug (41 chars)', () => {
      expect(isValidAppSlug('a' + 'b'.repeat(40))).toBe(true);
      expect(isValidAppSlug('a' + 'b'.repeat(41))).toBe(false);
    });

    it('rejects empty + too-short slugs', () => {
      expect(isValidAppSlug('')).toBe(false);
      expect(isValidAppSlug('a')).toBe(false);
      expect(isValidAppSlug('ab')).toBe(false);
    });

    it('rejects leading digit', () => {
      expect(isValidAppSlug('1abc')).toBe(false);
    });

    it('rejects leading underscore', () => {
      expect(isValidAppSlug('_abc')).toBe(false);
    });

    it('rejects uppercase', () => {
      expect(isValidAppSlug('Abc')).toBe(false);
      expect(isValidAppSlug('ABC123')).toBe(false);
    });

    it('rejects hyphens, spaces, quotes, and other SQL-relevant chars', () => {
      expect(isValidAppSlug('abc-def')).toBe(false);
      expect(isValidAppSlug('abc def')).toBe(false);
      expect(isValidAppSlug("abc'def")).toBe(false);
      expect(isValidAppSlug('abc"def')).toBe(false);
      expect(isValidAppSlug('abc;def')).toBe(false);
      expect(isValidAppSlug('abc--def')).toBe(false);
      expect(isValidAppSlug('abc/*def*/')).toBe(false);
    });

    it('rejects unicode tricks', () => {
      expect(isValidAppSlug('abc​')).toBe(false); // zero-width space
      expect(isValidAppSlug('абв')).toBe(false); // Cyrillic
    });

    it('rejects non-strings', () => {
      expect(isValidAppSlug(null)).toBe(false);
      expect(isValidAppSlug(undefined)).toBe(false);
      expect(isValidAppSlug(123 as unknown)).toBe(false);
      expect(isValidAppSlug({} as unknown)).toBe(false);
    });
  });

  describe('sanitizeAppSlug', () => {
    it('passes through a valid slug', () => {
      expect(sanitizeAppSlug('generate_from_model')).toBe('generate_from_model');
    });

    it('lowercases + replaces hyphens with underscore', () => {
      expect(sanitizeAppSlug('Generate-From-Model')).toBe('generate_from_model');
    });

    it('collapses runs of non-alnum into a single underscore', () => {
      expect(sanitizeAppSlug('a-_-b---c')).toBe('a_b_c');
    });

    it('strips leading/trailing underscores from the normalized form', () => {
      expect(sanitizeAppSlug('--abc--')).toBe('abc');
    });

    it('returns null when normalization fails the regex', () => {
      expect(sanitizeAppSlug('')).toBe(null);
      expect(sanitizeAppSlug('!!')).toBe(null);
      // becomes '1abc' which fails leading-digit
      expect(sanitizeAppSlug('1-abc')).toBe(null);
    });

    it('is idempotent', () => {
      const out = sanitizeAppSlug('Generate-From-Model');
      expect(sanitizeAppSlug(out!)).toBe(out);
    });

    it('returns null for non-strings', () => {
      expect(sanitizeAppSlug(null as unknown as string)).toBe(null);
      expect(sanitizeAppSlug(undefined as unknown as string)).toBe(null);
    });
  });

  describe('identifier helpers', () => {
    it('produces quoted schema + role identifiers', () => {
      expect(appSchemaIdent('generate_from_model')).toBe('"app_generate_from_model"');
      expect(appRoleIdent('generate_from_model')).toBe('"app_generate_from_model_role"');
    });

    it('throws when invalid slug reaches the identifier helpers', () => {
      expect(() => appSchemaIdent('invalid-slug')).toThrow(/invalid app slug/);
      expect(() => appRoleIdent('')).toThrow(/invalid app slug/);
      expect(() => appSchemaIdent('1bad')).toThrow(/invalid app slug/);
    });
  });

  describe('review preview schema ident (#2831)', () => {
    it('normalises a pubreq_<ULID> id to a lowercase alnum component', () => {
      expect(normalizeReviewPreviewId('pubreq_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
        'pubreq01arz3ndektsv4rrffq69g5fav'
      );
    });

    it('produces the quoted apprev_ schema for a publish request id', () => {
      expect(reviewPreviewSchemaIdent('pubreq_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
        '"apprev_pubreq01arz3ndektsv4rrffq69g5fav"'
      );
    });

    it('ISOLATION: the preview schema can NEVER alias a production app_<slug> schema', () => {
      // Production schemas are `app_` + slug (index-3 char is `_`); preview schemas
      // are `apprev_` + id (index-3 char is `r`) — so no slug can ever collide.
      const preview = reviewPreviewSchemaIdent('pubreq_abc');
      // Try to construct a matching production slug — impossible: `apprev_...`
      // cannot equal `app_<slug>` for any valid slug.
      expect(preview).toBe('"apprev_pubreqabc"');
      expect(preview.startsWith('"app_')).toBe(false);
      expect(preview.startsWith('"apprev_')).toBe(true);
      // A different publish request → a different schema (per-app isolation).
      expect(reviewPreviewSchemaIdent('pubreq_xyz')).not.toBe(preview);
    });

    it('throws (fail-shut) on an id that normalises to something unusable', () => {
      expect(() => reviewPreviewSchemaIdent('!!')).toThrow(/invalid review preview id/);
      expect(() => reviewPreviewSchemaIdent('')).toThrow(/invalid review preview id/);
      expect(normalizeReviewPreviewId(null)).toBe(null);
      expect(normalizeReviewPreviewId(42 as unknown as string)).toBe(null);
    });
  });
});

describe('newBlockIdError', () => {
  it.each(['my--app', 'a---b'])('refuses %s', (blockId) => {
    expect(newBlockIdError(blockId)).toBe(
      `blockId "${blockId}" must not contain consecutive hyphens ("--"): app storage treats a run of hyphens as a single separator, so it could share storage with another app. Use single hyphens.`
    );
  });

  it.each(['my-app', 'ab-c-d', 'plainapp'])('allows %s', (blockId) => {
    expect(newBlockIdError(blockId)).toBeNull();
  });

  // A name with its own DNS record shadows the static server's catch-all for app hosts, so an app
  // taking it would never be reachable at <blockId>.civit.ai.
  it.each([
    ['a-thing', 'a-', 'DNS ownership records'],
    ['aaaa-thing', 'aaaa-', 'DNS ownership records'],
    ['cname-thing', 'cname-', 'DNS ownership records'],
    ['dev-0123456789abcdef', 'dev-', 'dev tunnel hosts'],
    ['review-0123456789abcdef', 'review-', 'moderator review previews'],
  ])('refuses the reserved id %s', (blockId, prefix, usedFor) => {
    expect(newBlockIdError(blockId)).toBe(
      `blockId "${blockId}" is reserved: ids starting with "${prefix}" are used for ${usedFor}, so the app's address would never reach it. Choose a different blockId.`
    );
  });

  it('refuses www', () => {
    expect(newBlockIdError('www')).toBe('blockId "www" is reserved. Choose a different blockId.');
  });

  // INVARIANT guard, green before the reserved rule existed too: every app live on 2026-10-27,
  // plus near-misses of each reserved name, stays registrable.
  it.each([
    'ab-img-poster',
    'app-requests',
    'arcane-deck',
    'buzz',
    'buzz-generator',
    'character-sheet-studio',
    'civlings',
    'continuous-gen',
    'custom-generators',
    'dataset-commons',
    'df-qwen-canvas',
    'dogfood-manual',
    'email-builder',
    'generate-from-model',
    'gen-matrix',
    'goods-demo-app',
    'hello-world',
    'lora-matrix-tester',
    'lora-weight-lab',
    'metadata-medic',
    'model-benchmarking',
    'model-notes',
    'notepad',
    'oauth-probe',
    'oauth-test-block',
    'one-click-workflows',
    'panorama-360',
    'paywall-demo',
    'playable-collections',
    'poc-prompt-polisher',
    'pp-fighter',
    'prompt-library',
    'prompt-vault',
    'ramthrust-metadata-inspector',
    'seed-explorer',
    'sensei',
    'service-status',
    'strength-finder',
    'style-explorer',
    'turnaround',
    'w6-ui-dogfood',
    'yt-thumbnail',
    'abc-app',
    'cnamex',
    'dev',
    'devtools',
    'reviewer',
    'wwwx',
    'my-dev-app',
  ])('allows %s', (blockId) => {
    expect(newBlockIdError(blockId)).toBeNull();
  });

  it('the pair it exists to separate: both are pattern-legal and share one storage slug', () => {
    expect(SLUG_REGEX.test('my-app') && SLUG_REGEX.test('my--app')).toBe(true);
    expect(sanitizeAppSlug('my--app')).toBe('my_app');
    expect(sanitizeAppSlug('my-app')).toBe('my_app');
  });

  /** Every pattern-legal blockId of 3–6 chars over a small alphabet, plus length edges. */
  function patternLegalIds(): string[] {
    const alphabet = ['a', 'b', '7', '-'];
    let frontier = [''];
    const all: string[] = [];
    for (let len = 1; len <= 6; len++) {
      frontier = frontier.flatMap((prefix) => alphabet.map((ch) => prefix + ch));
      if (len >= 3) all.push(...frontier);
    }
    all.push('a' + 'b'.repeat(39), 'a-' + 'b'.repeat(38), 'a' + 'b-'.repeat(19) + 'b');
    return all.filter((id) => id.length <= 40 && SLUG_REGEX.test(id));
  }

  it('among accepted pattern-legal blockIds, distinct ids never share a storage slug', () => {
    const accepted = patternLegalIds().filter((id) => newBlockIdError(id) === null);
    expect(accepted.length).toBeGreaterThan(1000);

    const idBySlug = new Map<string, string>();
    for (const id of accepted) {
      const slug = sanitizeAppSlug(id);
      expect(slug, id).toBe(id.replaceAll('-', '_'));
      expect(idBySlug.get(slug!), `${id} collides`).toBeUndefined();
      idBySlug.set(slug!, id);
    }
  });

  it('without the rule the same generated set does collide (the property test can go red)', () => {
    const slugs = patternLegalIds().map((id) => sanitizeAppSlug(id));
    expect(new Set(slugs).size).toBeLessThan(slugs.length);
  });

  it('every file that creates an app block row applies the rule, and no other file does', () => {
    const scan = scanSource(process.cwd(), {
      newBlockIdError: 'src/server/utils/apps-slug.ts',
    });
    const creates = /\bappBlock\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/;
    const creators = scan.files.filter((f) => creates.test(scan.code.get(f)!)).sort();
    expect(creators).toEqual([
      'src/pages/api/v1/developer/block-manifests.ts',
      'src/server/services/blocks/publish-request.service.ts',
    ]);
    expect(scan.callersOf('newBlockIdError')).toEqual(creators);
  });
});
