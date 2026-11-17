import { describe, expect, it } from 'vitest';

import {
  MAX_ISSUE_TRACKER_URL_LENGTH,
  validateIssueTrackerUrl,
} from '~/server/schema/blocks/external-app.schema';

/**
 * `validateIssueTrackerUrl` — the ONE rule for the issue-tracker / support link, shared by the
 * off-site listing form, its zod schema, the service and the manifest `bugs` key.
 *
 * The rule: https only, a host, no embedded credentials, no port, ≤200 chars, ANY host. The
 * bound is spelled as a literal here so a change to the constant has to change this file too.
 */
describe('validateIssueTrackerUrl', () => {
  it('the length bound is 200', () => {
    expect(MAX_ISSUE_TRACKER_URL_LENGTH).toBe(200);
  });

  it.each([
    ['a forge issues page', 'https://github.com/o/r/issues', 'https://github.com/o/r/issues'],
    ['a non-forge host', 'https://support.example.com/', 'https://support.example.com/'],
    [
      'a deep path with a query',
      'https://example.org/help?topic=app',
      'https://example.org/help?topic=app',
    ],
    [
      'surrounding whitespace (trimmed)',
      '  https://example.com/bugs  ',
      'https://example.com/bugs',
    ],
    ['an upper-case host (normalised)', 'https://EXAMPLE.com/bugs', 'https://example.com/bugs'],
    [
      'the default https port (dropped by the parser)',
      'https://example.com:443/bugs',
      'https://example.com/bugs',
    ],
  ])('ACCEPTS %s', (_label, input, normalised) => {
    expect(validateIssueTrackerUrl(input)).toEqual({ ok: true, url: normalised });
  });

  it('accepts a URL of exactly 200 characters', () => {
    const base = 'https://example.com/';
    const url = base + 'a'.repeat(200 - base.length);
    expect(url.length).toBe(200);
    expect(validateIssueTrackerUrl(url).ok).toBe(true);
  });

  it.each([
    ['http', 'http://example.com/bugs', /https/],
    ['mailto', 'mailto:help@example.com', /https/],
    ['javascript', 'javascript:alert(1)', /https/],
    ['embedded credentials', 'https://user:pass@example.com/bugs', /credentials/],
    ['a username only', 'https://user@example.com/bugs', /credentials/],
    ['an explicit non-default port', 'https://example.com:8443/bugs', /port/],
    ['not a URL', 'not a url', /not a valid absolute URL/],
    ['an empty string', '', /must not be empty/],
    ['whitespace only', '   ', /must not be empty/],
  ])('REJECTS %s', (_label, input, message) => {
    const res = validateIssueTrackerUrl(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(message);
      // The author filled in the issue tracker field; the message must name it, not the
      // externalUrl validator it delegates to.
      expect(res.error).toContain('issueTrackerUrl');
      expect(res.error).not.toContain('externalUrl');
    }
  });

  it('REJECTS a URL of 201 characters', () => {
    const base = 'https://example.com/';
    const url = base + 'a'.repeat(201 - base.length);
    const res = validateIssueTrackerUrl(url);
    expect(res).toEqual({ ok: false, error: 'issueTrackerUrl must be ≤ 200 chars' });
  });

  it('REJECTS a value that is not a string', () => {
    expect(validateIssueTrackerUrl(42)).toEqual({
      ok: false,
      error: 'issueTrackerUrl must be a string',
    });
    expect(validateIssueTrackerUrl({ url: 'https://example.com' }).ok).toBe(false);
  });
});
