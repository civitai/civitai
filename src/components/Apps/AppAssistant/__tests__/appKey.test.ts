import { describe, expect, it } from 'vitest';
import {
  APP_KEY_MAX_LENGTH,
  appKeyError,
  isAppBlockId,
} from '~/components/Apps/AppAssistant/appKey';

describe('appKeyError (the sandbox service accepts 1-200 characters)', () => {
  it.each([
    ['', 'Enter a name for the app'],
    ['   ', 'Enter a name for the app'],
    ['a', null],
    ['My App!', null],
    ['x'.repeat(APP_KEY_MAX_LENGTH), null],
    ['x'.repeat(APP_KEY_MAX_LENGTH + 1), 'Keep it to 200 characters or fewer'],
  ])('%j → %j', (key, error) => {
    expect(appKeyError(key)).toBe(error);
  });
});

describe('isAppBlockId (the slug rule a dev tunnel needs)', () => {
  it.each([
    ['ab', false],
    ['abc', true],
    ['a'.repeat(40), true],
    ['a'.repeat(41), false],
    ['my-app-2', true],
    ['2-app', false],
    ['-app', false],
    ['app-', false],
    ['My-App', false],
    ['my_app', false],
  ])('%j → %s', (key, ok) => {
    expect(isAppBlockId(key)).toBe(ok);
  });
});
