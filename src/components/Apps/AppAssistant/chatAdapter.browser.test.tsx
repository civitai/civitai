import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { CivitaiChat } from '@civitai/components-chat/civitai-chat';
import '@civitai/components-chat/civitai-chat/define';
import { isDictating, messageBoxText } from '~/components/Apps/AppAssistant/chatAdapter';

afterEach(() => {
  document.querySelectorAll('civitai-chat').forEach((el) => el.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'mediaDevices');
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

/**
 * A microphone whose recorder finishes only when the test says so, as a real one finishes a moment
 * after it is told to stop: that moment is the one between the recording bar and the transcribing bar.
 */
function fakeMicrophone() {
  const finishes: (() => void)[] = [];
  class FakeRecorder extends EventTarget {
    static isTypeSupported = (type: string) => type.startsWith('audio/webm');
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      finishes.push(() => {
        this.dispatchEvent(
          Object.assign(new Event('dataavailable'), {
            data: new Blob(['said'], { type: this.mimeType }),
          })
        );
        this.dispatchEvent(new Event('stop'));
      });
    }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('AudioWorkletNode', undefined);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => undefined }] })) },
  });
  /** Lets every recorder told to stop so far finish. */
  return () => finishes.splice(0).forEach((finish) => finish());
}

/**
 * The real element, signed in to a fake app, so it offers the microphone. Every request answers 503,
 * except that once `holdRequests()` is called, new ones never answer: the transcription stays running.
 */
async function realSignedInChat() {
  let hold = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      hold
        ? new Promise<never>(() => undefined)
        : Promise.resolve(new Response('{}', { status: 503 }))
    )
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const chat = document.createElement('civitai-chat') as CivitaiChat;
  chat.app = {
    getToken: async () => 'token',
    requestGrants: async () => true,
    site: { get: async () => ({ username: 'viewer' }) },
    orchestration: {
      queryWorkflows: async () => ({ items: [], next: '' }),
      submitWorkflow: vi.fn(),
    },
  } as never;
  document.body.append(chat);
  const box = page.getByRole('textbox', { name: 'Message' });
  await expect.element(box).toBeVisible();
  return { chat, box, holdRequests: () => (hold = true) };
}

/**
 * Presses one of the chat's buttons with a DOM click, as the chat's own tests do. A Playwright click
 * on the microphone button took about five seconds here, enough to time the test out under load.
 */
async function press(name: string) {
  const button = page.getByRole('button', { name });
  await expect.element(button).toBeVisible();
  (button.element() as HTMLElement).click();
}

test('reads what the user typed in the real chat’s message box, and what the page put there', async () => {
  const { chat, box } = await realChat();
  expect(messageBoxText(chat)).toBe('');
  await box.fill('Add a dark mode');
  expect(messageBoxText(chat)).toBe('Add a dark mode');
  expect(messageBoxText(chat)).toBe(chat.draft);
  await chat.compose('Make it blue');
  expect(messageBoxText(chat)).toBe('Make it blue');
  expect(isDictating(chat)).toBe(false);
});

test('NEGATIVE CONTROL: no chat, or a chat not drawn yet, has an empty box and no dictation', () => {
  expect(messageBoxText(null)).toBe('');
  expect(messageBoxText(document.createElement('civitai-chat') as CivitaiChat)).toBe('');
  expect(isDictating(null)).toBe(false);
  expect(isDictating(document.createElement('civitai-chat') as CivitaiChat)).toBe(false);
});

test('tracks the real chat’s dictation: while recording, in the moment after the user stops, and while transcribing', async () => {
  const finishRecording = fakeMicrophone();
  const { chat, box, holdRequests } = await realSignedInChat();
  await box.fill('draw');
  expect(isDictating(chat)).toBe(false);

  await press('Talk instead of typing');
  await expect.element(page.getByRole('group', { name: 'Recording your voice' })).toBeVisible();
  await expect.element(box).not.toBeInTheDocument();
  expect(isDictating(chat)).toBe(true);
  expect(isDictating(chat)).toBe(chat.dictating);
  // The box is hidden; it still holds what it held.
  expect(messageBoxText(chat)).toBe('draw');

  // Stopped, the recorder is still handing over the last words: neither the recording nor the
  // transcribing bar is up, and the user is still dictating.
  await press('Stop and edit the text');
  await expect
    .element(page.getByRole('group', { name: 'Recording your voice' }))
    .not.toBeInTheDocument();
  expect(page.getByText('Turning what you said into text…').query()).toBeNull();
  expect(isDictating(chat)).toBe(true);
  expect(messageBoxText(chat)).toBe('draw');

  holdRequests();
  finishRecording();
  await expect.element(page.getByText('Turning what you said into text…')).toBeVisible();
  expect(isDictating(chat)).toBe(true);
  expect(messageBoxText(chat)).toBe('draw');

  await press('Stop transcribing');
  await expect.element(box).toBeVisible();
  expect(isDictating(chat)).toBe(false);
  expect(messageBoxText(chat)).toBe('draw');
});
