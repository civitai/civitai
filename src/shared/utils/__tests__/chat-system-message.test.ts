import { describe, expect, it } from 'vitest';
import { formatChatSystemMessage, upsertChatInList } from '~/shared/utils/chat';

/**
 * Chat feedback (868kwtpac): the system notes addressed the reader as "You"
 * with a raw substring replace, which left the verb agreeing with the name it
 * replaced — "You is now the group admin", "You was kicked".
 */

const forReader = (content: string, username?: string | null) =>
  formatChatSystemMessage({ content, username });

describe('formatChatSystemMessage', () => {
  it.each([
    ['alice is now the group admin', 'You are now the group admin'],
    ['alice was kicked', 'You were kicked'],
    ['alice was added', 'You were added'],
    ['alice joined', 'You joined'],
    ['alice left', 'You left'],
  ])('conjugates %j for the person it is about', (content, expected) => {
    expect(forReader(content, 'alice')).toBe(expected);
  });

  it('leaves a message about somebody else alone', () => {
    expect(forReader('bob was kicked', 'alice')).toBe('bob was kicked');
  });

  it('rewrites the reader inside a list without touching an already-plural verb', () => {
    expect(forReader('bob, alice, carol were added', 'alice')).toBe('bob, You, carol were added');
  });

  it('rewrites a reader who leads a list', () => {
    expect(forReader('alice, bob were added', 'alice')).toBe('You, bob were added');
  });

  it('does not match a name that merely starts with the username', () => {
    expect(forReader('alicia was kicked', 'alice')).toBe('alicia was kicked');
    expect(forReader('alice2 joined', 'alice')).toBe('alice2 joined');
  });

  it('leaves the username alone when it is not the subject', () => {
    expect(forReader('Group renamed to "alice"', 'alice')).toBe('Group renamed to "alice"');
  });

  it('returns the message untouched for a user with no username', () => {
    // The old `content.replace('', 'You')` matched at position zero and produced
    // "Youalice joined" for every system note.
    expect(forReader('alice joined', '')).toBe('alice joined');
    expect(forReader('alice joined', null)).toBe('alice joined');
    expect(forReader('alice joined', undefined)).toBe('alice joined');
  });

  it('treats a username with regex characters as literal text', () => {
    expect(forReader('a.c was kicked', 'a.c')).toBe('You were kicked');
    expect(forReader('abc was kicked', 'a.c')).toBe('abc was kicked');
  });
});

describe('upsertChatInList', () => {
  it('prepends a conversation the reader does not have yet', () => {
    expect(upsertChatInList([{ id: 1 }], { id: 2 })).toEqual([{ id: 2 }, { id: 1 }]);
  });

  it('starts the list when there is none', () => {
    expect(upsertChatInList(undefined, { id: 2 })).toEqual([{ id: 2 }]);
  });

  it('replaces in place rather than duplicating a conversation already held', () => {
    // Being invited back to a group you left replays `chat:new-room` for a
    // conversation still in your list.
    const list = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    expect(upsertChatInList(list, { id: 2, name: 'renamed' })).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'renamed' },
    ]);
  });
});
