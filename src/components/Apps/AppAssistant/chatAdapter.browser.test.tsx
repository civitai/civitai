import { beforeEach, describe, expect, test } from 'vitest';
import { createChatAppStore } from '~/components/Apps/AppAssistant/chatAdapter';

beforeEach(() => localStorage.clear());

describe('createChatAppStore', () => {
  test('keeps each chat’s app apart per account', () => {
    createChatAppStore('1').set('chat-a', 'sbx-one');
    createChatAppStore('2').set('chat-a', 'sbx-two');
    expect(createChatAppStore('1').get('chat-a')).toBe('sbx-one');
    expect(createChatAppStore('2').get('chat-a')).toBe('sbx-two');
    expect(createChatAppStore('1').get('chat-b')).toBeNull();
  });

  test('keeps the 50 chats set most recently, numeric ids included', () => {
    const store = createChatAppStore('1');
    for (let i = 0; i < 60; i++) store.set(String(i), `sbx-${i}`);
    // Setting an old chat again makes it recent.
    store.set('10', 'sbx-10b');
    store.set('60', 'sbx-60');
    expect(store.get('10')).toBe('sbx-10b');
    expect(store.get('60')).toBe('sbx-60');
    expect(store.get('59')).toBe('sbx-59');
    expect(store.get('11')).toBeNull();
    expect(store.get('12')).toBe('sbx-12');
  });

  test('reads unreadable storage as empty, and still saves over it', () => {
    localStorage.setItem('app-assistant:chat-apps:1', '{not json');
    const store = createChatAppStore('1');
    expect(store.get('chat-a')).toBeNull();
    store.set('chat-a', 'sbx-one');
    expect(store.get('chat-a')).toBe('sbx-one');
  });
});
