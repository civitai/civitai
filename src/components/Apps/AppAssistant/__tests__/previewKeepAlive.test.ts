import { describe, expect, test, vi } from 'vitest';
import {
  BACKGROUND_BRIDGE_TYPES,
  KEEPALIVE_MIN_INTERVAL_MS,
  createKeepAlive,
  isViewerBridgeMessage,
  pingSandbox,
} from '~/components/Apps/AppAssistant/previewKeepAlive';

describe('isViewerBridgeMessage', () => {
  test('a request the app makes for its viewer counts', () => {
    for (const type of ['SUBMIT_WORKFLOW', 'CREATE_POST_FROM_APP', 'APP_STORAGE_SET', 'NAVIGATE'])
      expect(isViewerBridgeMessage({ type, requestId: 'r1' })).toBe(true);
  });

  test('what an app sends by itself does not', () => {
    expect([...BACKGROUND_BRIDGE_TYPES].sort()).toEqual([
      'BLOCK_ERROR',
      'BLOCK_HELLO',
      'BLOCK_MESSAGE_REJECTED',
      'BLOCK_READY',
      'POLL_WORKFLOW',
      'REQUEST_TOKEN',
      'RESIZE_IFRAME',
      'TRACK_EVENT',
    ]);
    for (const type of BACKGROUND_BRIDGE_TYPES)
      expect(isViewerBridgeMessage({ type, requestId: 'r1' })).toBe(false);
  });

  test('anything not shaped like a bridge message does not', () => {
    for (const data of [null, undefined, 'SUBMIT_WORKFLOW', 7, {}, { type: '' }, { type: 3 }])
      expect(isViewerBridgeMessage(data)).toBe(false);
  });
});

describe('createKeepAlive', () => {
  test('the interval is one minute', () => {
    expect(KEEPALIVE_MIN_INTERVAL_MS).toBe(60_000);
  });

  test('pings on the first activity, then at most once per interval', () => {
    let t = 1_000_000;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t });

    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);

    t += 25_000; // mid-interval
    expect(k.activity()).toBe(false);
    t += 34_999; // 59 999 ms after the ping
    expect(k.activity()).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);

    t += 1; // exactly one interval
    expect(k.activity()).toBe(true);
    t += 90_000; // well past the next one
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  test('a custom interval is honoured', () => {
    let t = 0;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t, minIntervalMs: 7_000 });
    k.activity();
    t = 6_999;
    expect(k.activity()).toBe(false);
    t = 7_000;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  test('nothing while the pane is not shown, and that does not use up the interval', () => {
    let shown = false;
    const t = 5_000_000;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => shown, now: () => t });

    expect(k.activity()).toBe(false);
    expect(k.activity()).toBe(false);
    expect(ping).not.toHaveBeenCalled();

    shown = true;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('a failed ping is dropped, and the next activity past the interval tries again', async () => {
    let t = 0;
    const ping = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => {
        throw new Error('no token');
      })
      .mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t });
    expect(k.activity()).toBe(true);
    await Promise.resolve();
    t = 61_000;
    expect(k.activity()).toBe(true);
    t = 122_000;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(3);
  });
});

describe('pingSandbox', () => {
  const MCP_URL = 'https://sandbox.example/s/sbx-aaaaaaaaaaaa/mcp';
  const ok = () => new Response('{"jsonrpc":"2.0","id":"keepalive","result":{}}', { status: 200 });

  test('sends one MCP ping to the app, with the user’s sandbox token', async () => {
    const getToken = vi.fn().mockResolvedValue('tok-1');
    const fetchImpl = vi.fn().mockResolvedValue(ok());

    await expect(pingSandbox(MCP_URL, getToken, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MCP_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer tok-1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 'keepalive',
      method: 'ping',
    });
    expect(getToken).toHaveBeenCalledWith(undefined);
  });

  test('after a 401 asks for a fresh token once and tries again', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok());

    await expect(pingSandbox(MCP_URL, getToken, fetchImpl)).resolves.toBe(true);
    expect(getToken).toHaveBeenLastCalledWith({ refresh: true });
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer fresh',
    });
  });

  test('NEGATIVE CONTROL: a second 401 is not retried again, and a refusal reads false', async () => {
    const getToken = vi.fn().mockResolvedValue('tok');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(pingSandbox(MCP_URL, getToken, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const down = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(pingSandbox(MCP_URL, getToken, down)).resolves.toBe(false);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
