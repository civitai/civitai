import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { CivitaiChat } from '@civitai/components-chat/civitai-chat';
import '@civitai/components-chat/civitai-chat/define';
import {
  isDictating,
  listenReplyResume,
  messageBoxText,
} from '~/components/Apps/AppAssistant/chatAdapter';
import {
  releaseHeld,
  retryWhenReady,
  type Release,
} from '~/components/Apps/AppAssistant/AppAssistantWorkspace';

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
 * With `grants: false` the viewer refuses the chat their Buzz, so nothing they send goes.
 */
async function realSignedInChat({ grants = true } = {}) {
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
    requestGrants: async () => grants,
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

test('a message released into the real chat waits out its hold in the box, sends nothing meanwhile, and goes once the chat says it can', async () => {
  const { chat, box } = await realSignedInChat();
  chat.holdReason = 'Your app is starting…';
  await chat.updateComplete;
  expect(chat.canSend).toBe(false);
  const replaying: { current: Release | null } = { current: null };
  const went: string[] = [];
  // The page's before-send, as the workspace's onBeforeSend marks it: the message it is sending went.
  chat.addEventListener('before-send', (event) => {
    const text = (event as CustomEvent<{ text: string }>).detail.text;
    went.push(text);
    const release = replaying.current;
    if (release?.text === text) release.went = true;
  });
  const sends = vi.spyOn(chat, 'send');

  const kept = releaseHeld(
    { current: chat },
    replaying,
    () => messageBoxText(chat),
    () => isDictating(chat),
    'Add a dark mode',
    // Shorter than the test's own timeout, so an event that never comes fails here by assertion, with
    // room for a slow runner before the hold lifts.
    10_000
  );
  // The chat holds, so the message waits in its box for the user to see.
  await expect.element(box).toHaveValue('Add a dark mode');
  // Longer than several of the old retry intervals: still the one send that put it there.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(sends).toHaveBeenCalledTimes(1);
  expect(went).toEqual([]);

  chat.holdReason = undefined;
  expect(await kept).toBe(true);
  expect(went).toEqual(['Add a dark mode']);
  expect(sends).toHaveBeenCalledTimes(2);
  // The untouched copy leaves the box once the message went.
  await expect.element(box).toHaveValue('');
});

/**
 * The real element, signed in to a fake app, whose every reply loses its connection at once (Safari's
 * words, which the chat does not retry by itself): it fails with Retry, and a resume point. `asked()`
 * counts the reply requests.
 */
async function realChatWhoseRepliesFail() {
  let asked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('chat/completions')) return new Response('{}');
      if (!(JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean }).stream)
        return new Response('{}', { status: 503 });
      asked++;
      throw new TypeError('The network connection was lost.');
    })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const chat = document.createElement('civitai-chat') as CivitaiChat;
  chat.mcp = { orchestration: false, site: false } as never;
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
  await vi.waitFor(() => expect(chat.canSend).toBe(true), { timeout: 10_000 });
  await chat.send('build me a timer');
  await vi.waitFor(() =>
    expect(
      chat.shadowRoot!.querySelector('civitai-chat-turn civitai-alert[color="error"]')
    ).not.toBeNull()
  );
  await vi.waitFor(() => expect(chat.canSend).toBe(true));
  expect(asked).toBe(1);
  return { chat, asked: () => asked };
}

test('the real chat’s ask by itself as the page comes back online is kept back by a reply-resume hold, and retryReply then asks once', async () => {
  const { chat, asked } = await realChatWhoseRepliesFail();
  const triggers: string[] = [];
  const stop = listenReplyResume(chat, (trigger) => {
    triggers.push(trigger);
    return true;
  });
  window.dispatchEvent(new Event('online'));
  expect(triggers).toEqual(['online']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(asked()).toBe(1);
  // The page's own ask fires no reply-resume (the hold, still listening, would keep it back)...
  expect(await chat.retryReply()).toBe(true);
  await vi.waitFor(() => expect(asked()).toBe(2));
  expect(triggers).toEqual(['online']);
  // ...and counts as the chat's one ask by itself: failed again, coming back online asks nothing.
  await vi.waitFor(() => expect(chat.canSend).toBe(true));
  window.dispatchEvent(new Event('online'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(triggers).toEqual(['online']);
  expect(asked()).toBe(2);
  stop();
});

test('NEGATIVE CONTROL: a reply-resume listener that does not hold lets the real chat ask by itself', async () => {
  const { chat, asked } = await realChatWhoseRepliesFail();
  const triggers: string[] = [];
  const stop = listenReplyResume(chat, (trigger) => {
    triggers.push(trigger);
    return false;
  });
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(asked()).toBe(2));
  expect(triggers).toEqual(['online']);
  stop();
});

test('retryWhenReady asks the real chat for its failed reply only once it can send, and not at all once stopped', async () => {
  const { chat, asked } = await realChatWhoseRepliesFail();
  chat.holdReason = 'Your app is starting…';
  await chat.updateComplete;
  expect(chat.canSend).toBe(false);
  const retry = vi.spyOn(chat, 'retryReply');
  const asking = retryWhenReady({ current: chat }, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(retry).not.toHaveBeenCalled();
  chat.holdReason = undefined;
  expect(await asking).toBe(true);
  expect(retry).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(asked()).toBe(2));

  // Failed again: a stopped wait asks nothing when the hold lifts.
  await vi.waitFor(() => expect(chat.canSend).toBe(true));
  chat.holdReason = 'Your app is starting…';
  await chat.updateComplete;
  const stop = new AbortController();
  const stopped = retryWhenReady({ current: chat }, stop.signal);
  stop.abort();
  chat.holdReason = undefined;
  expect(await stopped).toBe(false);
  expect(retry).toHaveBeenCalledTimes(1);
});

test('a message the real chat keeps back on a refused grant while the user dictates is taken out of the box and reported unsent', async () => {
  fakeMicrophone();
  const { chat } = await realSignedInChat({ grants: false });
  await press('Talk instead of typing');
  await expect.element(page.getByRole('group', { name: 'Recording your voice' })).toBeVisible();
  expect(isDictating(chat)).toBe(true);
  // Nothing holds the chat: the refusal comes only once the message is sent.
  expect(chat.canSend).toBe(true);
  const fired = vi.fn();
  chat.addEventListener('before-send', fired);
  const compose = vi.spyOn(chat, 'compose');
  const replaying: { current: Release | null } = { current: null };
  const kept = await releaseHeld(
    { current: chat },
    replaying,
    () => messageBoxText(chat),
    () => isDictating(chat),
    'Add a dark mode',
    5_000
  );
  // The refused grant stopped it before before-send, and the copy it left was taken out.
  expect(fired).not.toHaveBeenCalled();
  expect(compose.mock.calls).toEqual([['']]);
  expect(kept).toBe(false);
  expect(messageBoxText(chat)).toBe('');
  expect(isDictating(chat)).toBe(true);
});
