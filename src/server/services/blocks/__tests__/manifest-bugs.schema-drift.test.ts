import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MAX_ISSUE_TRACKER_URL_LENGTH,
  validateIssueTrackerUrl,
} from '~/server/schema/blocks/external-app.schema';
import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import {
  buildListingIssueTrackerSync,
  resolveListingIssueTracker,
} from '~/server/services/blocks/app-listing-mapper';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Manifest `bugs` — the on-site author surface of the issue-tracker / support link.
 *
 * Three declarations of one rule must agree: the published schema (`public/schemas/app-block/
 * v1.json`, byte-mirrored by the CLI and the starters), the server's manifest validator, and the
 * mapper that turns an approved manifest into the listing's stored value.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'public/schemas/app-block/v1.json'), 'utf8')
) as {
  required?: string[];
  properties?: Record<string, { anyOf?: Array<Record<string, unknown>>; description?: string }>;
};

const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};

function manifestWith(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    blockId: 'my-app',
    version: '1.0.0',
    name: 'My App',
    contentRating: 'g',
    renderMode: 'iframe',
    trustTier: 'unverified',
    scopes: ['models:read:self'],
    iframe: {
      src: 'https://blocks.civitai.com/test',
      minHeight: 200,
      maxHeight: null,
      resizable: true,
      sandbox: 'allow-scripts',
    },
    ...extra,
  };
}

function errorsFor(extra: Record<string, unknown>): string[] {
  const res = BlockManifestValidator.validate(manifestWith(extra), APP_CTX);
  return res.valid ? [] : res.errors;
}

/** The exact refusal for any non-string `bugs` (an object included). Spelled as a literal. */
const NOT_A_STRING =
  'bugs must be a URL string (an object such as { "url": ... } is not supported)';

describe('app-block v1 schema — bugs', () => {
  it('declares bugs as an OPTIONAL URL STRING only (no object form), with the validator bound', () => {
    const bugs = schema.properties?.bugs as Record<string, unknown> | undefined;
    expect(bugs).toBeDefined();
    expect(schema.required ?? []).not.toContain('bugs');
    expect(bugs?.type).toBe('string');
    expect(bugs?.minLength).toBe(1);
    expect(bugs?.maxLength).toBe(MAX_ISSUE_TRACKER_URL_LENGTH);
    // 🔴 No `anyOf` / object arm: an editor must refuse `{ "url": ... }` as the server does.
    expect(bugs).not.toHaveProperty('anyOf');
    expect(bugs).not.toHaveProperty('oneOf');
  });

  it('the schema pattern rejects every non-https scheme the server rejects', () => {
    const bugs = schema.properties?.bugs as Record<string, unknown> | undefined;
    const re = new RegExp(String(bugs?.pattern));
    for (const bad of ['http://example.com/bugs', 'mailto:a@example.com', 'javascript:alert(1)']) {
      expect(validateIssueTrackerUrl(bad).ok, bad).toBe(false);
      expect(re.test(bad), `schema pattern accepted ${bad}`).toBe(false);
    }
    expect(re.test('https://example.com/bugs')).toBe(true);
  });
});

describe('BlockManifestValidator — bugs', () => {
  it('POSITIVE CONTROL: the base manifest is valid, so a rejection below is about bugs', () => {
    expect(errorsFor({})).toEqual([]);
  });

  it('ACCEPTS a URL string', () => {
    expect(errorsFor({ bugs: 'https://github.com/o/r/issues' })).toEqual([]);
  });

  it.each([
    ['an http string', 'http://example.com/bugs'],
    ['a mailto string', 'mailto:help@example.com'],
    ['a string with credentials', 'https://u:p@example.com/bugs'],
    ['a string with a port', 'https://example.com:8080/bugs'],
    ['a blank string', '   '],
  ])('REJECTS %s, naming the manifest key', (_label, bugs) => {
    const joined = errorsFor({ bugs }).join(' | ');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toContain('bugs');
    expect(joined).not.toContain('issueTrackerUrl');
  });

  it.each([
    // 🔴 The npm object form is REFUSED, not silently ignored — an author who wrote it must be
    // told, or their Support link simply never appears.
    ['an object with a valid url', { url: 'https://example.com/support' }],
    ['an object with url and email', { url: 'https://example.com/s', email: 'help@example.com' }],
    ['an object with only email', { email: 'help@example.com' }],
    ['an empty object', {}],
    ['a number', 42],
    ['an array', ['https://example.com']],
    ['null', null],
  ])('REJECTS bugs given as %s, with the exact message', (_label, bugs) => {
    expect(errorsFor({ bugs })).toEqual([NOT_A_STRING]);
  });

  it('agrees with validateIssueTrackerUrl on every string in the corpus', () => {
    for (const value of [
      'https://github.com/o/r/issues',
      'https://example.com',
      'http://example.com',
      'https://u@example.com',
      'https://example.com:9000',
      'not a url',
      'https://example.com/' + 'a'.repeat(190),
    ]) {
      expect(errorsFor({ bugs: value }).length === 0, value).toBe(
        validateIssueTrackerUrl(value).ok
      );
    }
  });
});

/**
 * 🔴 STRICT ONLY ON A NEW SUBMISSION. A manifest stored before the `bugs` rule existed (an
 * object, an http link, a port) must stay approvable and editable: on approve, the in-app
 * editor and git-push re-validation, a non-conforming `bugs` is a WARNING and yields no link —
 * never a refusal. Every other rule still refuses in lenient mode.
 */
describe('BlockManifestValidator — bugs outside a new submission (lenient)', () => {
  const LENIENT = { strictIssueTrackerLink: false } as const;
  const lenient = (extra: Record<string, unknown>) =>
    BlockManifestValidator.validate(manifestWith(extra), APP_CTX, LENIENT);

  it.each([
    ['an object', { url: 'https://example.com/s' }, NOT_A_STRING],
    ['an http string', 'http://example.com/bugs', null],
    ['a string with a port', 'https://example.com:8080/bugs', 'bugs must not specify a port'],
  ])('ACCEPTS %s with a warning naming it, and no error', (_label, bugs, firstPart) => {
    const res = lenient({ bugs });
    expect(res.valid).toBe(true);
    expect(res.warnings ?? []).toHaveLength(1);
    const warning = (res.warnings ?? [])[0];
    expect(warning).toContain('bugs');
    if (firstPart) expect(warning.startsWith(firstPart)).toBe(true);
    expect(warning.endsWith(' — ignored: the store shows no Support link')).toBe(true);
  });

  it('a valid string carries no warning', () => {
    expect(lenient({ bugs: 'https://example.com/bugs' })).toEqual({ valid: true });
  });

  it('POSITIVE CONTROL: the DEFAULT (a new submission) still refuses the same object', () => {
    expect(errorsFor({ bugs: { url: 'https://example.com/s' } })).toEqual([NOT_A_STRING]);
  });

  it('lenient mode relaxes ONLY bugs: another bad field still refuses', () => {
    const res = lenient({ bugs: { url: 'x' }, repository: 'http://github.com/o/r' });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.join(' | ')).toContain('repository');
  });

  it('validateSubmission passes the option through', async () => {
    const res = await BlockManifestValidator.validateSubmission(
      manifestWith({
        page: { path: '/', title: 'My App' },
        bugs: { url: 'https://example.com/s' },
      }),
      APP_CTX,
      LENIENT
    );
    expect(res.valid).toBe(true);
    expect(res.warnings ?? []).toHaveLength(1);
  });
});

describe('resolveListingIssueTracker — manifest → stored value', () => {
  it.each([
    ['a string', 'https://example.com/bugs', 'https://example.com/bugs'],
    // An object is not a link (the validator refuses it at submit; a legacy row yields none).
    ['an object with a valid url', { url: 'https://example.com/s' }, null],
    ['an object with only email', { email: 'a@example.com' }, null],
    ['absent', undefined, null],
    ['an invalid string (legacy row)', 'http://example.com', null],
    ['a non-string url', { url: 7 }, null],
  ])('%s', (_label, bugs, expected) => {
    expect(resolveListingIssueTracker(bugs === undefined ? {} : { bugs })).toBe(expected);
  });

  it('buildListingIssueTrackerSync writes NOTHING while the column is unavailable', () => {
    expect(
      buildListingIssueTrackerSync({
        manifest: { bugs: 'https://example.com/bugs' },
        issueTrackerAvailable: false,
      })
    ).toEqual({ write: false });
  });

  it('buildListingIssueTrackerSync CLEARS the link when the manifest drops bugs', () => {
    expect(buildListingIssueTrackerSync({ manifest: {}, issueTrackerAvailable: true })).toEqual({
      write: true,
      value: null,
    });
    expect(
      buildListingIssueTrackerSync({
        manifest: { bugs: 'https://EXAMPLE.com/b' },
        issueTrackerAvailable: true,
      })
    ).toEqual({ write: true, value: 'https://example.com/b' });
  });
});
