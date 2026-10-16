import { describe, expect, it } from 'vitest';
import { isAppBlockId, isCopyOf, newAppKey } from '~/components/Apps/AppAssistant/appKey';

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

describe('newAppKey', () => {
  it.each([
    ['Tip Calculator', 'tip-calculator'],
    ['  Café   Menu!! ', 'cafe-menu'],
    ['3D Model Viewer', 'app-3d-model-viewer'],
    ['my_cool app', 'my-cool-app'],
    ['🎲 dice roller', 'dice-roller'],
    ['', 'my-app'],
    ['!!', 'my-app'],
    ['ab', 'my-app'],
    ['42', 'app-42'],
    ['x', 'my-app'],
  ])('names %j as %j', (name, key) => {
    expect(newAppKey(name, [])).toBe(key);
  });

  it('keeps a long name within the 40-character blockId limit, without a trailing hyphen', () => {
    const key = newAppKey('A really quite long name for a small budgeting app', []);
    expect(key).toBe('a-really-quite-long-name-for-a-small-bud');
    expect(newAppKey('word '.repeat(20), [])).toBe('word-word-word-word-word-word-word-word');
  });

  it('numbers a name that is taken, skipping numbers that are taken too', () => {
    expect(newAppKey('Tip Calculator', ['tip-calculator'])).toBe('tip-calculator-2');
    expect(newAppKey('Tip Calculator', ['tip-calculator', 'tip-calculator-2'])).toBe(
      'tip-calculator-3'
    );
    expect(newAppKey('', ['my-app'])).toBe('my-app-2');
  });

  it('makes room for the number on a name already at the limit', () => {
    const long = 'a'.repeat(40);
    expect(newAppKey(long, [long])).toBe(`${'a'.repeat(38)}-2`);
    expect(newAppKey('abcdefghij-'.repeat(4), ['abcdefghij-abcdefghij-abcdefghij-abcdefg'])).toBe(
      'abcdefghij-abcdefghij-abcdefghij-abcde-2'
    );
  });

  it.each([
    'Tip Calculator',
    'x',
    '9 lives',
    'A really quite long name for a small budgeting app',
    'word '.repeat(20),
    'abcdefghi-'.repeat(4),
  ])('always returns a valid blockId for %j, even when taken', (name) => {
    const first = newAppKey(name, []);
    expect(isAppBlockId(first)).toBe(true);
    expect(isAppBlockId(newAppKey(name, [first]))).toBe(true);
  });
});

describe('isCopyOf (is this app the one, or a numbered copy of the one, the name asks for)', () => {
  it.each([
    ['tip-calculator', 'Tip calculator', true],
    ['tip-calculator-2', 'Tip calculator', true],
    ['tip-calculator-12', 'Tip calculator', true],
    ['tip-calculators', 'Tip calculator', false],
    ['tip-calculator-x', 'Tip calculator', false],
    ['quiz-game', 'Tip calculator', false],
    ['tip', 'Tip calculator', false],
    // A name ending in a number is read as written; its copies number after it.
    ['game-2', 'Game 2', true],
    ['game-2-2', 'Game 2', true],
    ['game', 'Game 2', false],
    // …so a copy of "Game" and an app named "Game 2" share a key, and either counts for "Game".
    ['game-2', 'Game', true],
    ['my-app-3', '', true],
  ])('%j for %j → %s', (key, name, copy) => {
    expect(isCopyOf(key, name)).toBe(copy);
  });

  it('knows a copy of a long name, which is cut short to fit its number', () => {
    const name = 'A really quite long name for a small budgeting app';
    const second = newAppKey(name, [newAppKey(name, [])]);
    expect(second).toBe('a-really-quite-long-name-for-a-small-b-2');
    expect(isCopyOf(second, name)).toBe(true);
    expect(isCopyOf(second, 'A really quite long name for a small')).toBe(false);
  });
});
