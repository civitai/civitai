import { describe, expect, it, vi } from 'vitest';
import type { EmailSendRecord } from '../client';
import { createRemoteSendRecorder, EMAIL_EVENTS_INTERNAL_PATH } from '../remote-recorder';

const record: EmailSendRecord = {
  sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
  sentAt: new Date('2026-11-25T10:20:30.456Z'),
  template: 'verification',
  mailClass: 'transactional',
  campaign: '',
  variant: '',
  userId: 0,
};

describe('createRemoteSendRecorder', () => {
  it('POSTs the row, and only the row, to the main app with the service credential', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const recorder = createRemoteSendRecorder({
      baseUrl: 'https://main.test/',
      token: 'svc-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })!;
    await recorder(record);
    expect(EMAIL_EVENTS_INTERNAL_PATH).toBe('/api/internal/email-events');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://main.test/api/internal/email-events');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer svc-token',
      'content-type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      sends: [{ ...record, sentAt: '2026-11-25T10:20:30.456Z' }],
    });
  });

  it.each([
    ['no base URL', { baseUrl: '', token: 't' }],
    ['no token', { baseUrl: 'https://main.test', token: '' }],
    ['a blank token', { baseUrl: 'https://main.test', token: '  ' }],
  ])('is null with %s: nothing is recorded, nothing is sent', (_, opts) => {
    expect(createRemoteSendRecorder(opts)).toBeNull();
  });

  it('never throws or rejects: a refused, failed or aborted POST is reported and dropped', async () => {
    const onError = vi.fn();
    const answers = [
      async () => new Response(null, { status: 401 }),
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ];
    for (const answer of answers) {
      const recorder = createRemoteSendRecorder({
        baseUrl: 'https://main.test',
        token: 't',
        onError,
        fetch: answer as unknown as typeof globalThis.fetch,
      })!;
      await expect(recorder(record)).resolves.toBeUndefined();
    }
    expect(onError.mock.calls).toEqual([['status 401'], ['TypeError'], ['TimeoutError']]);
  });

  it('a hung main app is aborted after the timeout, so the POST never holds on', async () => {
    const onError = vi.fn();
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      );
    const recorder = createRemoteSendRecorder({
      baseUrl: 'https://main.test',
      token: 't',
      onError,
      timeoutMs: 20,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })!;
    await expect(recorder(record)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('TimeoutError');
  });
});
