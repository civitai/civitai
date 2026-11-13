import { describe, expect, it } from 'vitest';
import { copyFor } from './error-copy';

const GENERIC_403 = 'You do not have access to this page.';

describe('copyFor', () => {
  it('says what a 403 route said', () => {
    const copy = copyFor(403, 'Moderators only.');
    expect(copy.body).toBe('Moderators only.');
    expect(copy).toMatchObject({
      kicker: 'A sealed door',
      title: 'This door is not yours to open',
      icon: 'lock',
    });
  });

  it('keeps the generic line for a 403 with no message', () => {
    expect(copyFor(403).body).toBe(GENERIC_403);
    expect(copyFor(403, 'Error: 403').body).toBe(GENERIC_403);
    expect(copyFor(403, '  ').body).toBe(GENERIC_403);
  });

  it('never shows a 5xx message', () => {
    expect(copyFor(500, 'connection refused at db:5432').body).toBe(
      'It is not something you did. Try again in a moment.'
    );
  });
});
