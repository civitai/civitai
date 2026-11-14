import { describe, expect, it } from 'vitest';
import { NotificationsClientError } from '@civitai/notifications';
import { isDefinitiveRejection } from './rejection';

describe('isDefinitiveRejection', () => {
  it.each([
    ['a 400', new NotificationsClientError('bad', 400, false)],
    ['a 401', new NotificationsClientError('auth', 401, false)],
    ['a 429', new NotificationsClientError('slow down', 429, true)],
  ])('treats %s as not accepted', (_, error) => {
    expect(isDefinitiveRejection(error)).toBe(true);
  });

  it.each([
    [
      'a client error with no status, even when not retryable',
      new NotificationsClientError('no endpoint', undefined, false),
    ],
    ['a timeout or dropped connection', new NotificationsClientError('aborted', undefined, true)],
    ['a 500', new NotificationsClientError('boom', 500, true)],
    ['a 503', new NotificationsClientError('down', 503, true)],
    ['an error of unknown origin', new Error('socket hang up')],
    ['a non-error throw', 'boom'],
    [
      'an error of unknown origin that looks like a validation error',
      Object.assign(new Error('x'), { name: 'ZodError' }),
    ],
  ])('treats %s as unknown', (_, error) => {
    expect(isDefinitiveRejection(error)).toBe(false);
  });
});
