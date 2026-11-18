import { describe, expect, it } from 'vitest';
import { assertBlockSubjectIsSessionUser } from '~/server/services/block-token-session-subject';

/**
 * The shared "block token subject must be the session user" check. Its two callers
 * (`blocks.router.ts`'s bridge writes and `blockImageUpload.persist`'s share stamp) are pinned
 * through their procedures in `blocks.router.persistUploadedGenerationSource.test.ts`,
 * `block-token-auth.characterisation.procedures.test.ts` and
 * `block-image-upload.router.persistStamp.test.ts`; this pins the helper's own contract.
 */

const SESSION = 42;

/** The error the call threw, or `undefined` when it passed. */
function thrown(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('assertBlockSubjectIsSessionUser', () => {
  it('passes when the subject is the session user', () => {
    expect(thrown(() => assertBlockSubjectIsSessionUser(SESSION, SESSION))).toBeUndefined();
  });

  it.each([
    ['another user', 7],
    ['an anonymous or unparseable subject (null)', null],
  ])('🔴 refuses %s FORBIDDEN with the default message', (_label, subject) => {
    expect(thrown(() => assertBlockSubjectIsSessionUser(subject, SESSION))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
  });

  it('refuses with the caller’s own message when one is given', () => {
    expect(
      thrown(() =>
        assertBlockSubjectIsSessionUser(7, SESSION, 'block token is not for this viewer')
      )
    ).toMatchObject({ code: 'FORBIDDEN', message: 'block token is not for this viewer' });
  });

  it('passes with a caller’s message when the subject matches', () => {
    expect(
      thrown(() =>
        assertBlockSubjectIsSessionUser(SESSION, SESSION, 'block token is not for this viewer')
      )
    ).toBeUndefined();
  });
});
