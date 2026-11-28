import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmailSendRecorder, setEmailSendRecorder } from '@civitai/email';
import { registerEmailSendRecorder } from '../send-recorder';

// The app's wiring only: the recorder's POST and its fire-and-forget contract are pinned in
// @civitai/email (remote-recorder.test.ts, client.test.ts).
const KEYS = ['CIVITAI_APP_URL', 'AUTH_INTERNAL_TOKEN'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const record = {
  sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
  sentAt: new Date('2026-11-25T00:00:00.000Z'),
  template: 'caseNotice',
  mailClass: 'transactional' as const,
  campaign: '',
  variant: '',
  userId: 0,
};

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  setEmailSendRecorder(null);
  vi.unstubAllGlobals();
});

describe('the moderator email send recorder', () => {
  it('POSTs each send row to CIVITAI_APP_URL with AUTH_INTERNAL_TOKEN', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    process.env.CIVITAI_APP_URL = 'https://main.test/';
    process.env.AUTH_INTERNAL_TOKEN = 'svc';
    expect(registerEmailSendRecorder()).toBe(true);
    await getEmailSendRecorder()!(record);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://main.test/api/internal/email-events');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer svc');
    expect(JSON.parse(String(init.body)).sends[0].template).toBe('caseNotice');
  });

  it('registers nothing without AUTH_INTERNAL_TOKEN', () => {
    process.env.CIVITAI_APP_URL = 'https://main.test';
    expect(registerEmailSendRecorder()).toBe(false);
    expect(getEmailSendRecorder()).toBeNull();
  });
});
