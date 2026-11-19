import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { approveCommitRequestId, buildApproveCommitMessage } from '../approve-provenance';

/**
 * approveCommitRequestId reads back the request id buildApproveCommitMessage writes. The git-push
 * webhook uses it to recognise the platform's own approve commit, so reader and writer must agree
 * on every shape the writer produces, and the reader must refuse anything else.
 */

const ZIP_ID = 'pubreq_01M774DDAE7SXFN23WB0KTYJ0Z';
const PUSH_ID = 'pubreq_01M6GDH78HAAK30J2QAKJHT6FH';
const BARE_ID = '01JC0000000000000000000ABC';

const writerInputs = [
  {
    publishRequestId: ZIP_ID,
    slug: 'custom-thing',
    version: '0.17.1',
    sourceCommit: '9120d6b51793ec5108885373ca8ccf80135988c8',
    sourceDirty: false,
    sourceRepo: 'https://github.com/someone/custom-thing',
  },
  {
    publishRequestId: PUSH_ID,
    slug: 'pushed-app',
    version: '2.0.0-beta.1',
    pushedCommit: 'fedcba9876543210fedcba9876543210fedcba98',
  },
  { publishRequestId: BARE_ID, slug: 'bare-app', version: 'not-semver' },
];

function gitTrailerValues(message: string, key: string): string[] {
  const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: message })
    .toString()
    .split('\n');
  return parsed.filter((l) => l.startsWith(`${key}: `)).map((l) => l.slice(key.length + 2));
}

describe('approveCommitRequestId', () => {
  it.each(writerInputs)(
    '🔴 reads back the id buildApproveCommitMessage writes ($publishRequestId)',
    (input) => {
      const message = buildApproveCommitMessage(input);
      expect(approveCommitRequestId(message)).toBe(input.publishRequestId);
      // git's own trailer parser sees the same single id.
      expect(gitTrailerValues(message, 'Publish-Request')).toEqual([input.publishRequestId]);
    }
  );

  it('reads a pinned approve message', () => {
    expect(
      approveCommitRequestId(
        `Approved publish request ${ZIP_ID} — custom-thing v0.17.1\n` +
          '\n' +
          `Publish-Request: ${ZIP_ID}\n` +
          'App-Version: 0.17.1\n' +
          'Source-Commit: 9120d6b51793ec5108885373ca8ccf80135988c8\n' +
          'Source-Dirty: false\n'
      )
    ).toBe(ZIP_ID);
  });

  it('tolerates CRLF line ends and a missing or doubled final newline', () => {
    const message = buildApproveCommitMessage(writerInputs[0]);
    expect(approveCommitRequestId(message.replace(/\n/g, '\r\n'))).toBe(ZIP_ID);
    expect(approveCommitRequestId(message.replace(/\n$/, ''))).toBe(ZIP_ID);
    expect(approveCommitRequestId(`${message}\n\n`)).toBe(ZIP_ID);
  });

  it.each([
    ['not a string', undefined],
    ['not a string (number)', 42],
    ['empty', ''],
    // The subject every approve wrote before trailers existed: not recognised, so those commits
    // keep the marker checks only.
    ['a subject with no trailers', `Approved publish request ${ZIP_ID} — custom-thing v0.17.1`],
    ['a manifest edit', `Manifest update: custom-thing v0.17.2\n\nPublish-Request: ${ZIP_ID}\n`],
    [
      'a developer commit quoting the trailer in its body',
      `fix header\n\nPublish-Request: ${ZIP_ID}\n`,
    ],
    [
      'a trailer naming a different request than the subject',
      `Approved publish request ${ZIP_ID} — custom-thing v0.17.1\n\nPublish-Request: ${PUSH_ID}\n`,
    ],
    [
      'two Publish-Request trailers',
      `Approved publish request ${ZIP_ID} — custom-thing v0.17.1\n\nPublish-Request: ${ZIP_ID}\nPublish-Request: ${ZIP_ID}\n`,
    ],
    [
      'a final paragraph that is not all trailers',
      `Approved publish request ${ZIP_ID} — custom-thing v0.17.1\n\nPublish-Request: ${ZIP_ID}\nand some prose\n`,
    ],
    [
      'the trailer in an earlier paragraph only',
      `Approved publish request ${ZIP_ID} — custom-thing v0.17.1\n\nPublish-Request: ${ZIP_ID}\n\nApp-Version: 0.17.1\n`,
    ],
    [
      'an id the platform never mints',
      'Approved publish request bad.id — custom-thing v0.17.1\n\nPublish-Request: bad.id\n',
    ],
    [
      'a subject that only starts the same way',
      `Approved publish request ${ZIP_ID}x — custom-thing v0.17.1\n\nPublish-Request: ${ZIP_ID}\n`,
    ],
  ])('refuses %s', (_label, message) => {
    expect(approveCommitRequestId(message)).toBeNull();
  });
});
