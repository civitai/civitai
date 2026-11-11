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

function errorsFor(extra: Record<string, unknown>): string[] {
  const res = BlockManifestValidator.validate(
    {
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
    },
    APP_CTX
  );
  return res.valid ? [] : res.errors;
}

describe('app-block v1 schema — bugs', () => {
  it('declares bugs as OPTIONAL, string-or-object, with the validator length bound', () => {
    const bugs = schema.properties?.bugs;
    expect(bugs).toBeDefined();
    expect(schema.required ?? []).not.toContain('bugs');
    const [asString, asObject] = bugs?.anyOf ?? [];
    expect(asString?.type).toBe('string');
    expect(asString?.maxLength).toBe(MAX_ISSUE_TRACKER_URL_LENGTH);
    expect(asObject?.type).toBe('object');
    const urlProp = (asObject?.properties as Record<string, Record<string, unknown>>)?.url;
    expect(urlProp?.type).toBe('string');
    expect(urlProp?.maxLength).toBe(MAX_ISSUE_TRACKER_URL_LENGTH);
  });

  it('the schema pattern rejects every non-https scheme the server rejects', () => {
    const [asString] = schema.properties?.bugs?.anyOf ?? [];
    const re = new RegExp(String(asString?.pattern));
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

  it.each([
    ['a URL string', 'https://github.com/o/r/issues'],
    ['an object with url', { url: 'https://example.com/support' }],
    ['an object with url and email (email ignored)', { url: 'https://example.com/s', email: 'x' }],
    ['an object with only email (no link, ignored)', { email: 'help@example.com' }],
  ])('ACCEPTS %s', (_label, bugs) => {
    expect(errorsFor({ bugs })).toEqual([]);
  });

  it.each([
    ['an http string', 'http://example.com/bugs', 'bugs'],
    ['a mailto string', 'mailto:help@example.com', 'bugs'],
    ['a string with credentials', 'https://u:p@example.com/bugs', 'bugs'],
    ['a string with a port', 'https://example.com:8080/bugs', 'bugs'],
    ['a blank string', '   ', 'bugs'],
    ['an object with an http url', { url: 'http://example.com/bugs' }, 'bugs.url'],
    ['an object with a non-string url', { url: 42 }, 'bugs.url'],
  ])('REJECTS %s, naming the manifest key', (_label, bugs, key) => {
    const joined = errorsFor({ bugs }).join(' | ');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toContain(key);
    expect(joined).not.toContain('issueTrackerUrl');
  });

  it.each([
    ['a number', 42],
    ['an array', ['https://example.com']],
    ['null', null],
  ])('REJECTS bugs given as %s', (_label, bugs) => {
    expect(errorsFor({ bugs }).join(' | ')).toContain('bugs must be a URL string or an object');
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

describe('resolveListingIssueTracker — manifest → stored value', () => {
  it.each([
    ['a string', 'https://example.com/bugs', 'https://example.com/bugs'],
    ['an object url', { url: 'https://EXAMPLE.com/s' }, 'https://example.com/s'],
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
        manifest: { bugs: { url: 'https://example.com/b' } },
        issueTrackerAvailable: true,
      })
    ).toEqual({ write: true, value: 'https://example.com/b' });
  });
});
