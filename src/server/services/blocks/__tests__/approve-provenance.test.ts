import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  approvalTagName,
  approveTrailers,
  buildApproveCommitMessage,
  decideVersionTag,
  MAX_TRAILER_VALUE_LENGTH,
  versionTagName,
} from '../approve-provenance';

const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const PUSHED = 'fedcba9876543210fedcba9876543210fedcba98';

const zip = {
  publishRequestId: '01JC0000000000000000000ABC',
  slug: 'hello-app',
  version: '1.2.3',
  sourceCommit: SOURCE,
  sourceDirty: false,
  sourceRepo: 'https://github.com/someone/hello-app',
};

/** git's own trailer parser: the oracle for what a reader of the commit will see. */
function gitTrailers(message: string): string {
  return execFileSync('git', ['interpret-trailers', '--parse'], { input: message }).toString();
}

describe('buildApproveCommitMessage', () => {
  it('🔴 a zip approve: the unchanged subject, a blank line, then the trailers in a fixed order', () => {
    expect(buildApproveCommitMessage(zip)).toBe(
      'Approved publish request 01JC0000000000000000000ABC — hello-app v1.2.3\n' +
        '\n' +
        'Publish-Request: 01JC0000000000000000000ABC\n' +
        'App-Version: 1.2.3\n' +
        `Source-Commit: ${SOURCE}\n` +
        'Source-Dirty: false\n' +
        'Source-Repo: https://github.com/someone/hello-app\n'
    );
  });

  it('a dirty tree is reported as Source-Dirty: true', () => {
    expect(approveTrailers({ ...zip, sourceDirty: true })).toContainEqual(['Source-Dirty', 'true']);
  });

  it('an UNKNOWN dirty flag is omitted, never written as false', () => {
    for (const sourceDirty of [null, undefined]) {
      const keys = approveTrailers({ ...zip, sourceDirty }).map(([k]) => k);
      expect(keys).toEqual(['Publish-Request', 'App-Version', 'Source-Commit', 'Source-Repo']);
    }
  });

  it('no reported commit: neither Source-Commit nor Source-Dirty (dirty is never emitted alone)', () => {
    for (const sourceCommit of [
      null,
      undefined,
      '',
      'not-a-sha',
      SOURCE.toUpperCase(),
      SOURCE.slice(0, 39),
    ]) {
      const keys = approveTrailers({ ...zip, sourceCommit, sourceDirty: true }).map(([k]) => k);
      expect(keys).toEqual(['Publish-Request', 'App-Version', 'Source-Repo']);
    }
  });

  it('🔴 a push-originated request: Pushed-Commit, and the pushed sha never appears as Source-Commit', () => {
    const message = buildApproveCommitMessage({
      publishRequestId: 'pubreq_push',
      slug: 'hello-app',
      version: '1.2.3',
      sourceCommit: null,
      sourceDirty: null,
      sourceRepo: undefined,
      pushedCommit: PUSHED,
    });
    expect(message).toBe(
      'Approved publish request pubreq_push — hello-app v1.2.3\n\n' +
        'Publish-Request: pubreq_push\n' +
        'App-Version: 1.2.3\n' +
        `Pushed-Commit: ${PUSHED}\n`
    );
  });

  it('a manifest without a repository: no Source-Repo', () => {
    for (const sourceRepo of [
      undefined,
      null,
      42,
      { url: 'x' },
      'http://github.com/a/b',
      'git@github.com:a/b.git',
    ]) {
      expect(approveTrailers({ ...zip, sourceRepo }).map(([k]) => k)).not.toContain('Source-Repo');
    }
  });

  // Each value tries to end the trailer line and forge another trailer (or the whole
  // provenance block). The oracle is git's own parser: whatever it extracts must be exactly the
  // honest trailers.
  it.each([
    ['newline', 'https://github.com/a/b\nSource-Commit: ' + 'a'.repeat(40)],
    ['carriage return', 'https://github.com/a/b\rSource-Dirty: false'],
    ['NUL', 'https://github.com/a/b\u0000x'],
    ['space', 'https://github.com/a/b Source-Dirty: false'],
    ['tab', 'https://github.com/a/b\tx'],
    ['unicode line separator', 'https://github.com/a/b\u2028Source-Dirty: false'],
    ['over the length cap', 'https://github.com/' + 'a'.repeat(MAX_TRAILER_VALUE_LENGTH)],
  ])('🔴 trailer injection through repository (%s) is dropped, not forged', (_name, sourceRepo) => {
    const message = buildApproveCommitMessage({ ...zip, sourceRepo, sourceDirty: true });
    expect(gitTrailers(message)).toBe(
      'Publish-Request: 01JC0000000000000000000ABC\n' +
        'App-Version: 1.2.3\n' +
        `Source-Commit: ${SOURCE}\n` +
        'Source-Dirty: true\n'
    );
  });

  it('🔴 a version carrying a newline cannot break the subject or forge a trailer', () => {
    const message = buildApproveCommitMessage({
      ...zip,
      version: '1.2.3\n\nSource-Commit: ' + 'b'.repeat(40),
    });
    expect(message.split('\n')[0]).toBe(
      `Approved publish request 01JC0000000000000000000ABC — hello-app v1.2.3Source-Commit: ${'b'.repeat(
        40
      )}`
    );
    // The unsafe version is dropped as a trailer; the real Source-Commit is the only one.
    expect(gitTrailers(message)).toBe(
      'Publish-Request: 01JC0000000000000000000ABC\n' +
        `Source-Commit: ${SOURCE}\n` +
        'Source-Dirty: false\n' +
        'Source-Repo: https://github.com/someone/hello-app\n'
    );
  });

  it('git parses the message into exactly the trailers written (real git)', () => {
    expect(gitTrailers(buildApproveCommitMessage({ ...zip, pushedCommit: PUSHED }))).toBe(
      'Publish-Request: 01JC0000000000000000000ABC\n' +
        'App-Version: 1.2.3\n' +
        `Pushed-Commit: ${PUSHED}\n` +
        `Source-Commit: ${SOURCE}\n` +
        'Source-Dirty: false\n' +
        'Source-Repo: https://github.com/someone/hello-app\n'
    );
  });
});

describe('version tag naming', () => {
  it.each(['1.2.3', '0.0.1', '1.2.3-rc.1', '1.2.3+build.5', '1.2.3-alpha-1+sha.abc', '10.20.30'])(
    'semver %s names a tag git accepts (real git check-ref-format)',
    (version) => {
      const tag = versionTagName(version);
      expect(tag).toBe(`v${version}`);
      expect(() =>
        execFileSync('git', ['check-ref-format', `refs/tags/${tag}`], { stdio: 'pipe' })
      ).not.toThrow();
    }
  );

  it.each([
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.2.3-',
    '1.2.3..4',
    '1.2.3 x',
    '1.2.3\n',
    '1.2.3~1',
    '',
  ])('a non-semver version %j is not tagged', (version) => {
    expect(versionTagName(version)).toBeNull();
  });

  it('the per-approval tag is a valid ref and refuses an id that is not one of ours', () => {
    const tag = approvalTagName('01JC0000000000000000000ABC');
    expect(tag).toBe('approved-01JC0000000000000000000ABC');
    expect(() =>
      execFileSync('git', ['check-ref-format', `refs/tags/${tag}`], { stdio: 'pipe' })
    ).not.toThrow();
    expect(approvalTagName('a/b')).toBeNull();
    expect(approvalTagName('a..b')).toBeNull();
    expect(approvalTagName('')).toBeNull();
  });
});

describe('decideVersionTag', () => {
  const base = { version: '1.2.3', publishRequestId: 'pubreq_2', approvedSha: 'a'.repeat(40) };

  it('no tag yet: create v<version>', () => {
    expect(decideVersionTag({ ...base, existingVersionTag: null })).toEqual({
      action: 'create',
      tag: 'v1.2.3',
    });
  });

  it('the tag already names this commit: nothing to do (idempotent re-delivery)', () => {
    expect(
      decideVersionTag({ ...base, existingVersionTag: { commitSha: 'a'.repeat(40) } })
    ).toEqual({ action: 'exists', tag: 'v1.2.3' });
  });

  it('🔴 the tag names ANOTHER commit: never moved; this approval gets approved-<id>', () => {
    expect(
      decideVersionTag({ ...base, existingVersionTag: { commitSha: 'b'.repeat(40) } })
    ).toEqual({
      action: 'fallback',
      tag: 'approved-pubreq_2',
      versionTag: 'v1.2.3',
      versionTagSha: 'b'.repeat(40),
    });
  });

  it('a version that cannot name a tag is skipped, with the reason', () => {
    expect(decideVersionTag({ ...base, version: 'nope', existingVersionTag: null })).toEqual({
      action: 'skip',
      reason: 'version "nope" is not semver',
    });
  });
});
