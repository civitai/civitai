import { describe, expect, it } from 'vitest';
import { LATEST_UPDATE_ID, parseEntry, UPDATE_ENTRIES, unseenCount, updatesFor } from './entries';

const file = (head: string, body = 'Where to find it.') => `---\n${head}\n---\n${body}\n`;

describe('the whats-new folder', () => {
  // Every real file: a bad one fails here, before it can reach a player.
  it('has only entries the dialog can show, newest first, with unique ids', () => {
    expect(UPDATE_ENTRIES.length).toBeGreaterThan(0);
    const ids = UPDATE_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect(LATEST_UPDATE_ID).toBe(ids[0]);
  });
});

describe('parseEntry', () => {
  it('reads the fields and joins the body into one line', () => {
    expect(
      parseEntry(
        '2030-01-01-settings',
        file(
          'title: Settings have a home.\nminRank: Knight\nlink: /settings\nlinkText: Open Settings',
          'First line\nsecond line.'
        )
      )
    ).toEqual({
      id: '2030-01-01-settings',
      title: 'Settings have a home.',
      body: 'First line second line.',
      minRank: 'Knight',
      link: { href: '/settings', text: 'Open Settings' },
    });
  });

  it('needs only a title and a body', () => {
    expect(parseEntry('2030-01-01-a', file('title: T.'))).toMatchObject({
      minRank: null,
      link: null,
    });
  });

  it.each([
    ['a name without a date', 'settings', file('title: T.')],
    ['a date that is not one', '2030-13-45-a', file('title: T.')],
    ['no field block', '2030-01-01-a', 'Just text.'],
    ['no title', '2030-01-01-a', file('minRank: Knight')],
    ['no body', '2030-01-01-a', file('title: T.', '')],
    ['an unknown field', '2030-01-01-a', file('title: T.\nwhen: questionsServed')],
    ['a field given twice', '2030-01-01-a', file('title: T.\ntitle: U.')],
    ['a rank that does not exist', '2030-01-01-a', file('title: T.\nminRank: Squire')],
    ['a link without its text', '2030-01-01-a', file('title: T.\nlink: /settings')],
    ['a link off the game', '2030-01-01-a', file('title: T.\nlink: https://x.test\nlinkText: Go')],
    ['a protocol-relative link', '2030-01-01-a', file('title: T.\nlink: //x.test\nlinkText: Go')],
    ['HTML in the copy', '2030-01-01-a', file('title: T.', '<b>bold</b>')],
  ])('refuses %s', (_why, id, raw) => {
    expect(() => parseEntry(id, raw)).toThrow(`whats-new/${id}.md`);
  });
});

describe('updatesFor and unseenCount', () => {
  const entries = [
    parseEntry('2030-01-02-knights', file('title: K.\nminRank: Knight')),
    parseEntry('2030-01-01-all', file('title: A.')),
  ];

  it('gives each rank the entries it can use', () => {
    expect(updatesFor('Acolyte', entries).map((e) => e.id)).toEqual(['2030-01-01-all']);
    expect(updatesFor('Paladin', entries).map((e) => e.id)).toEqual([
      '2030-01-02-knights',
      '2030-01-01-all',
    ]);
  });

  it('counts the entries newer than the last seen, or every one when none was seen', () => {
    expect(unseenCount(entries, null)).toBe(2);
    expect(unseenCount(entries, '2030-01-01-all')).toBe(1);
    expect(unseenCount(entries, '2030-01-02-knights')).toBe(0);
  });
});
