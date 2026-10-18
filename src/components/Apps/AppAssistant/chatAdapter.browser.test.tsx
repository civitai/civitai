import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import type { CivitaiChat } from '@civitai/components-chat/civitai-chat';
import '@civitai/components-chat/civitai-chat/define';
import { messageBoxText } from '~/components/Apps/AppAssistant/chatAdapter';

afterEach(() => {
  document.querySelectorAll('civitai-chat').forEach((el) => el.remove());
});

/** The real element, signed out: it draws its message box without an app. */
async function realChat() {
  const chat = document.createElement('civitai-chat') as CivitaiChat;
  chat.signIn = async () => {
    throw new Error('no sign-in in this test');
  };
  document.body.append(chat);
  const box = page.getByRole('textbox', { name: 'Message' });
  await expect.element(box).toBeVisible();
  return { chat, box };
}

test('reads what the user typed in the real chat’s message box, and what the page put there', async () => {
  const { chat, box } = await realChat();
  expect(messageBoxText(chat)).toBe('');
  await box.fill('Add a dark mode');
  expect(messageBoxText(chat)).toBe('Add a dark mode');
  await chat.compose('Make it blue');
  expect(messageBoxText(chat)).toBe('Make it blue');
});

test('NEGATIVE CONTROL: a chat not drawn yet has an empty box', () => {
  expect(messageBoxText(null)).toBe('');
  expect(messageBoxText(document.createElement('civitai-chat') as CivitaiChat)).toBe('');
});
