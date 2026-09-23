import { describe, expect, it } from 'vitest';
import { isProbeableMediaKey } from '../media-key';

/**
 * The ONE predicate every media-existence check imports — today the publish guard in both
 * `resolveIngestionError` runtimes, which ENFORCES on a refusal. Earlier revisions carried a copy
 * each, built by OPPOSITE construction, and the disagreement was not theoretical: for
 * `some-file.png` the negative spelling probed, got a 404 and permanently refused a moderator
 * publish, while the positive spelling never asked.
 *
 * Every expectation here is a hand-written literal. Deriving one from the regex would make the test
 * agree with whatever the implementation now says.
 */
describe('isProbeableMediaKey', () => {
  it('accepts the bare uuid every key-minting site issues', () => {
    // `randomUUID()` output: no prefix, no extension, no path.
    expect(isProbeableMediaKey('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true);
    expect(isProbeableMediaKey('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
  });

  it('is case-insensitive, because callers do not normalise the column', () => {
    expect(isProbeableMediaKey('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe(true);
  });

  it('is BROADER than the write validators, never narrower', () => {
    /**
     * The sound direction, asserted rather than assumed: zod's `.uuid()` rejects an invalid version
     * nibble, this accepts it. So every value `imageSchema` admitted as a key still passes here, and
     * the guard can never decline to check a key the schema already called a key.
     */
    expect(isProbeableMediaKey('aaaaaaaa-bbbb-9ccc-1ddd-eeeeeeeeeeee')).toBe(true);
  });

  it('rejects the legacy external-avatar urls the profile-picture path stores verbatim', () => {
    for (const url of [
      'https://cdn.discordapp.com/avatars/123/abc.png',
      'https://avatars.githubusercontent.com/u/12345',
      'https://lh3.googleusercontent.com/a/AAcHTtd',
      'http://example.com/x.png',
    ]) {
      expect(isProbeableMediaKey(url), url).toBe(false);
    }
  });

  it('rejects a `blob:` handle, whose embedded uuid is a browser handle and not a key', () => {
    // 🔴 The reason a bare-uuid EXTRACTION would be wrong where a whole-string MATCH is right: this
    // value contains something uuid-shaped and is not remotely a bucket key.
    expect(
      isProbeableMediaKey('blob:https://civitai.com/0f8fad5b-d9cb-469f-a165-70867728950e')
    ).toBe(false);
    expect(isProbeableMediaKey('data:image/png;base64,AAAA')).toBe(false);
  });

  it('rejects the unvalidated shapes the comics router and article sync can write', () => {
    /**
     * 🔴 These are the cases that decided which construction to keep, and they are NOT hypothetical:
     * seven `comics.router.ts` call sites validate the url with `z.string().min(1)`, and the article
     * `edge-media` sync copies the attribute verbatim out of sanitized HTML. Under the negative
     * (scheme-based) spelling every one of them was handed to the bucket, 404'd, and became a
     * permanent refusal to publish. Under this one they are simply not asked about.
     */
    for (const value of [
      'some-file.png',
      'photo.jpg',
      '12345',
      'foo/0f8fad5b-d9cb-469f-a165-70867728950e',
      '0f8fad5b-d9cb-469f-a165-70867728950e/width=450',
      'some/path:with-a-colon',
      '../../etc/passwd',
      '',
    ]) {
      expect(isProbeableMediaKey(value), value).toBe(false);
    }
  });

  it('rejects whitespace padding rather than trimming it', () => {
    // Trimming would make the predicate disagree with the key the row actually holds, which is what
    // any subsequent HEAD would be sent.
    expect(isProbeableMediaKey('  0f8fad5b-d9cb-469f-a165-70867728950e  ')).toBe(false);
    expect(isProbeableMediaKey('0f8fad5b-d9cb-469f-a165-70867728950e\n')).toBe(false);
  });

  it('rejects every non-string, so a null column cannot reach a bucket', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isProbeableMediaKey(value)).toBe(false);
    }
  });
});
