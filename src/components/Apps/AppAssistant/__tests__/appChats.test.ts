// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest';
import {
  APP_CHATS_MAX,
  appChatOf,
  appOfChat,
  rememberAppChat,
} from '~/components/Apps/AppAssistant/appChats';

beforeEach(() => {
  localStorage.clear();
});

describe('appChats', () => {
  test('a chat remembered for one user is not another user’s', () => {
    rememberAppChat(1, 'sticker-maker', 'chat-1');
    expect(appChatOf(1, 'sticker-maker')).toBe('chat-1');
    expect(appChatOf(2, 'sticker-maker')).toBeNull();
    expect(appOfChat(2, 'chat-1')).toBeNull();
  });

  test(`keeps the latest ${APP_CHATS_MAX} apps: one more evicts the oldest`, () => {
    for (let i = 0; i <= APP_CHATS_MAX; i++) rememberAppChat(1, `app-${i}`, `chat-${i}`);
    expect(appChatOf(1, 'app-0')).toBeNull();
    expect(appChatOf(1, 'app-1')).toBe('chat-1');
    expect(appChatOf(1, `app-${APP_CHATS_MAX}`)).toBe(`chat-${APP_CHATS_MAX}`);
  });

  test('stored JSON that is malformed or not a map reads as nothing known', () => {
    for (const stored of ['{not json', '[]', '"chat-1"', '{"sticker-maker": 7}']) {
      localStorage.setItem('app-assistant:app-chats:1', stored);
      expect(appChatOf(1, 'sticker-maker')).toBeNull();
      expect(appOfChat(1, 'chat-1')).toBeNull();
    }
  });

  test('a chat that chooses another app is no longer the first app’s', () => {
    rememberAppChat(1, 'sticker-maker', 'chat-1');
    rememberAppChat(1, 'tip-calculator', 'chat-1');
    expect(appChatOf(1, 'sticker-maker')).toBeNull();
    expect(appOfChat(1, 'chat-1')).toBe('tip-calculator');
  });
});
